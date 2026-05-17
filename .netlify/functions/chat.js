const fs = require('fs');
const path = require('path');

// ─── FAQ Database ─────────────────────────────────────────────────────────────
// Cache at module level — persists across warm Netlify function invocations.
// Reloaded only on cold start (deploy or after ~10 min inactivity).
let cachedFAQs = null;

function loadFAQDatabase() {
  if (cachedFAQs) return cachedFAQs;

  try {
    const faqPath = path.join(process.cwd(), 'micbt_faq_database.xml');
    const xmlContent = fs.readFileSync(faqPath, 'utf8');

    const faqs = [];
    const faqMatches = xmlContent.matchAll(/<faq[^>]*>[\s\S]*?<\/faq>/g);

    for (const match of faqMatches) {
      const block = match[0];
      const question = block.match(/<question>([\s\S]*?)<\/question>/)?.[1] || '';
      const answer   = block.match(/<answer>([\s\S]*?)<\/answer>/)?.[1]   || '';
      const keywords = block.match(/<keywords>([\s\S]*?)<\/keywords>/)?.[1] || '';
      // Step stored as child element <step>1.1</step>, not as XML attribute
      const step     = block.match(/<step>([^<]+)<\/step>/)?.[1]?.trim()   || '';

      if (question && answer) {
        faqs.push({
          question: question.trim(),
          answer:   answer.trim(),
          keywords: keywords.trim().split(',').map(k => k.trim()).filter(Boolean),
          step,
        });
      }
    }

    cachedFAQs = faqs;
    console.log(`FAQ database loaded: ${faqs.length} entries`);
    return faqs;
  } catch (error) {
    console.warn('Could not load FAQ database:', error.message);
    return [];
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────
// Returns top 5 FAQs by relevance.
// currentStep (e.g. "1.1") gives a score bonus to FAQs from the same step.
function searchFAQ(userQuestion, faqs, currentStep = '') {
  if (!faqs.length) return [];

  const qLower = userQuestion.toLowerCase();
  const words  = qLower.split(/\W+/).filter(w => w.length > 3);

  const scored = faqs.map(faq => {
    let score = 0;

    // Keyword match — highest signal (3 pts each)
    faq.keywords.forEach(kw => {
      if (qLower.includes(kw.toLowerCase())) score += 3;
    });

    // Word match against question and answer
    words.forEach(word => {
      if (faq.question.toLowerCase().includes(word)) score += 1;
      if (faq.answer.toLowerCase().includes(word))   score += 0.5;
    });

    // Step relevance boost — FAQs from the user's current step score higher
    if (currentStep && faq.step === currentStep) score += 2;

    return { ...faq, score };
  });

  return scored
    .filter(faq => faq.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ─── Format FAQ context ───────────────────────────────────────────────────────
function formatFAQContext(relevantFAQs) {
  if (!relevantFAQs.length) return '';

  return `Relevant Q&As from the MiCBT knowledge base:\n\n${
    relevantFAQs
      .map(faq => `Q: ${faq.question}\nA: ${faq.answer}`)
      .join('\n\n')
  }\n\n`;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
// NOTE: global.questionCounts is in-memory and resets on cold starts (~10 min
// inactivity) and across concurrent function instances. This means the limit
// is soft — users can exceed it by waiting or through concurrent requests.
// For a hard limit, replace with Netlify Blobs, Upstash Redis, or similar KV.
const MAX_QUESTIONS_PER_DAY = 6;

function getUserIdentifier(event) {
  return (
    event.headers['client-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    'anonymous'
  );
}

function checkRateLimit(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key   = `${userId}:${today}`;

  if (!global.questionCounts) global.questionCounts = {};

  const count    = (global.questionCounts[key] || 0) + 1;
  global.questionCounts[key] = count;

  const allowed   = count <= MAX_QUESTIONS_PER_DAY;
  const remaining = Math.max(0, MAX_QUESTIONS_PER_DAY - count);

  return { allowed, used: count - 1, remaining, limit: MAX_QUESTIONS_PER_DAY };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  const API_KEY = process.env.CLAUDE_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'API key not configured' }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Rate limit check
  const userId       = getUserIdentifier(event);
  const rateLimitInfo = checkRateLimit(userId);

  if (!rateLimitInfo.allowed) {
    return {
      statusCode: 429,
      body: JSON.stringify({
        error:              'Daily question limit reached. Please try again tomorrow.',
        questionsUsed:      rateLimitInfo.used,
        questionsRemaining: 0,
        dailyLimit:         rateLimitInfo.limit,
      }),
    };
  }

  const { messages, systemPrompt, currentStep = '' } = body;

  // Load (cached) FAQ database
  const faqs = loadFAQDatabase();

  // Find the user's latest message
  const userMessages   = (messages || []).filter(m => m.role === 'user');
  const latestQuestion = userMessages.length > 0
    ? userMessages[userMessages.length - 1].content
    : '';

  // Search for relevant FAQs, weighted toward the user's current step
  const relevantFAQs = searchFAQ(latestQuestion, faqs, currentStep);
  const faqContext   = formatFAQContext(relevantFAQs);

  // Inject FAQ context into system prompt
  const enhancedSystemPrompt = faqContext
    ? `${systemPrompt}\n\n${faqContext}\nUse the Q&As above to inform your answer, but respond naturally. For checklists and homework, give the complete list.`
    : systemPrompt;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 2048,  // increased from 1024 — supports thorough complete answers
        system:     enhancedSystemPrompt,
        messages:   messages || [],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: err }) };
    }

    const data = await response.json();

    const responseBody = {
      ...data,
      questionsUsed:      rateLimitInfo.used,
      questionsRemaining: rateLimitInfo.remaining,
      dailyLimit:         rateLimitInfo.limit,
    };

    if (rateLimitInfo.remaining <= 3 && rateLimitInfo.remaining > 0) {
      responseBody.warning = `You have ${rateLimitInfo.remaining} question${rateLimitInfo.remaining === 1 ? '' : 's'} remaining today.`;
    }

    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify(responseBody),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
