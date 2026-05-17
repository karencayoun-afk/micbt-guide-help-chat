const fs   = require('fs');
const path = require('path');

const MAX_QUESTIONS_PER_DAY = 6;

// FAQ cache — loaded once per function instance
let faqCache = null;

function loadFAQDatabase() {
  if (faqCache) return faqCache;
  try {
    const faqPath = path.join(process.cwd(), 'micbt_faq_database.xml');
    const xml     = fs.readFileSync(faqPath, 'utf8');
    const faqs    = [];
    for (const match of xml.matchAll(/<faq[^>]*>([\s\S]*?)<\/faq>/g)) {
      const block    = match[1];
      const question = (block.match(/<question>([\s\S]*?)<\/question>/) || [])[1] || '';
      const answer   = (block.match(/<answer>([\s\S]*?)<\/answer>/)     || [])[1] || '';
      const keywords = (block.match(/<keywords>([\s\S]*?)<\/keywords>/) || [])[1] || '';
      const step     = (block.match(/<step>([\s\S]*?)<\/step>/)         || [])[1] || '';
      if (question && answer) {
        faqs.push({
          question: question.trim(),
          answer:   answer.trim(),
          keywords: keywords.trim().split(',').map(k => k.trim()).filter(Boolean),
          step:     step.trim()
        });
      }
    }
    faqCache = faqs;
    console.log('FAQ database loaded: ' + faqs.length + ' entries');
    return faqs;
  } catch (err) {
    console.warn('Could not load FAQ database:', err.message);
    return [];
  }
}

function searchFAQ(userQuestion, faqs, currentStep) {
  if (!faqs.length) return [];
  const q     = userQuestion.toLowerCase();
  const words = q.split(/\W+/).filter(function(w) { return w.length > 3; });

  const scored = faqs.map(function(faq) {
    let score = 0;
    faq.keywords.forEach(function(kw) {
      if (q.includes(kw.toLowerCase())) score += 3;
    });
    words.forEach(function(word) {
      if (faq.question.toLowerCase().includes(word)) score += 2;
      if (faq.answer.toLowerCase().includes(word))   score += 0.5;
    });
    if (currentStep && faq.step && faq.step === currentStep) score += 2;
    return Object.assign({}, faq, { score: score });
  });

  return scored
    .filter(function(f) { return f.score > 0; })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, 8);
}

function formatFAQContext(faqs) {
  if (!faqs.length) return '';
  return 'RELEVANT KNOWLEDGE BASE ENTRIES:\n\n' +
    faqs.map(function(f) { return 'Q: ' + f.question + '\nA: ' + f.answer; }).join('\n\n') +
    '\n\n---\n\n';
}

function getUserId(event) {
  return event.headers['client-ip'] ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'anonymous';
}

async function checkRateLimit(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key   = userId + ':' + today;
  if (!global.questionCounts) global.questionCounts = {};
  const count = (global.questionCounts[key] || 0) + 1;
  global.questionCounts[key] = count;
  return {
    allowed:   count <= MAX_QUESTIONS_PER_DAY,
    remaining: Math.max(0, MAX_QUESTIONS_PER_DAY - count),
    limit:     MAX_QUESTIONS_PER_DAY
  };
}

function friendlyError(type) {
  const map = {
    overloaded_error:     "I'm a little busy right now — please try again in a moment.",
    rate_limit_error:     "I'm a little busy right now — please try again in a moment.",
    context_length_error: "That conversation has grown quite long. Try starting a fresh session.",
    authentication_error: "There's a configuration issue. Please contact support@mindfulness.net.au.",
    api_error:            "Something went wrong on my end. Please try again shortly."
  };
  return map[type] || "Something went wrong. Please try again in a moment.";
}

function respond(status, body) {
  return {
    statusCode: status,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify(body)
  };
}

exports.handler = async function(event) {
  const API_KEY = process.env.CLAUDE_API_KEY;
  if (!API_KEY)                      return respond(500, { error: 'API key not configured' });
  if (event.httpMethod !== 'POST')   return respond(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body); }
  catch { return respond(400, { error: 'Invalid JSON' }); }

  const userId   = getUserId(event);
  const rateInfo = await checkRateLimit(userId);

  if (!rateInfo.allowed) {
    return respond(429, {
      error:              'limit',
      questionsRemaining: 0,
      dailyLimit:         rateInfo.limit
    });
  }

  const messages     = body.messages     || [];
  const systemPrompt = body.systemPrompt || '';
  const currentStep  = body.currentStep  || '';

  // Server-side FAQ retrieval — only inject what's relevant
  const faqs       = loadFAQDatabase();
  const lastUser   = messages.slice().reverse().find(function(m) { return m.role === 'user'; });
  const latestQ    = lastUser ? lastUser.content : '';
  const relevant   = searchFAQ(latestQ, faqs, currentStep);
  const faqContext = formatFAQContext(relevant);

  const fullSystem = faqContext
    ? systemPrompt + '\n\n' + faqContext +
      'Use the knowledge base entries above to inform your answer when relevant. Respond naturally and directly.'
    : systemPrompt;

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system:     fullSystem,
        messages:   messages
      })
    });

    if (!apiRes.ok) {
      let errType = 'api_error';
      try {
        const errData = await apiRes.json();
        errType = (errData.error && errData.error.type) ? errData.error.type : 'api_error';
      } catch {}
      return respond(apiRes.status, {
        error:              friendlyError(errType),
        questionsRemaining: rateInfo.remaining,
        dailyLimit:         rateInfo.limit
      });
    }

    const data = await apiRes.json();
    return respond(200, Object.assign({}, data, {
      questionsRemaining: rateInfo.remaining,
      dailyLimit:         rateInfo.limit
    }));

  } catch (err) {
    return respond(500, {
      error:              friendlyError('api_error'),
      questionsRemaining: rateInfo.remaining,
      dailyLimit:         rateInfo.limit
    });
  }
};
