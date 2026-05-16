const fs = require('fs');
const path = require('path');

// Load and parse FAQ database
function loadFAQDatabase() {
  try {
    const faqPath = path.join(process.cwd(), 'micbt_faq_database.xml');
    const xmlContent = fs.readFileSync(faqPath, 'utf8');
    
    // Simple XML parsing to extract Q&As
    const faqs = [];
    const faqMatches = xmlContent.matchAll(/<faq[^>]*>[\s\S]*?<\/faq>/g);
    
    for (const match of faqMatches) {
      const faqBlock = match[0];
      const question = faqBlock.match(/<question>([\s\S]*?)<\/question>/)?.[1] || '';
      const answer = faqBlock.match(/<answer>([\s\S]*?)<\/answer>/)?.[1] || '';
      const keywords = faqBlock.match(/<keywords>([\s\S]*?)<\/keywords>/)?.[1] || '';
      
      if (question && answer) {
        faqs.push({
          question: question.trim(),
          answer: answer.trim(),
          keywords: keywords.trim().split(',').map(k => k.trim()),
          stage: faqBlock.match(/stage="(\d+)"/)?.[1] || ''
        });
      }
    }
    
    return faqs;
  } catch (error) {
    console.warn('Could not load FAQ database:', error.message);
    return [];
  }
}

// Search FAQ by relevance
function searchFAQ(userQuestion, faqs, stage) {
  if (!faqs.length) return [];
  
  const questionLower = userQuestion.toLowerCase();
  const scored = faqs.map(faq => {
    let score = 0;
    
    // Keyword matching
    faq.keywords.forEach(keyword => {
      if (questionLower.includes(keyword.toLowerCase())) {
        score += 3;
      }
    });
    
    // Question content matching
    const words = questionLower.split(/\W+/);
    words.forEach(word => {
      if (word.length > 3) {
        if (faq.question.toLowerCase().includes(word)) score += 1;
        if (faq.answer.toLowerCase().includes(word)) score += 0.5;
      }
    });
    
    // Stage relevance
    if (faq.stage && faq.stage === stage.toString()) {
      score += 2;
    }
    
    return { ...faq, score };
  });
  
  return scored
    .filter(faq => faq.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5); // Return top 5 most relevant
}

// Format FAQ context for Claude
function formatFAQContext(relevantFAQs) {
  if (!relevantFAQs.length) {
    return '';
  }
  
  return `Here are relevant Q&As from the MiCBT Guide knowledge base:\n\n${
    relevantFAQs
      .map(faq => `Q: ${faq.question}\nA: ${faq.answer}`)
      .join('\n\n')
  }\n\n`;
}

// Get user identifier from request
function getUserIdentifier(event) {
  // Use IP address as identifier
  return event.headers['client-ip'] || 
         event.headers['x-forwarded-for']?.split(',')[0] || 
         'anonymous';
}

// Check rate limit (questions per day)
async function checkRateLimit(userId, maxQuestionsPerDay = 6) {
  // Use Netlify's data store (KV) if available, otherwise use in-memory (resets on redeploy)
  // For now, we'll use a simple in-memory store
  
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}:${today}`;
  
  // Note: In production, you'd use a persistent database
  // This is a simplified version that resets on function restart
  if (!global.questionCounts) {
    global.questionCounts = {};
  }
  
  const count = (global.questionCounts[key] || 0) + 1;
  global.questionCounts[key] = count;
  
  return count <= maxQuestionsPerDay;
}

// Main handler
exports.handler = async function(event) {
  const API_KEY = process.env.CLAUDE_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "API key not configured" })
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

  // Check rate limit
  const userId = getUserIdentifier(event);
  const withinLimit = await checkRateLimit(userId, 6); // 6 questions per day
  
  if (!withinLimit) {
    return {
      statusCode: 429,
      body: JSON.stringify({ 
        error: "Daily question limit reached. Please try again tomorrow." 
      })
    };
  }

  const { messages, systemPrompt, stage = 1 } = body;

  // Load FAQ database
  const faqs = loadFAQDatabase();
  
  // Get user's latest question
  const userMessages = messages.filter(m => m.role === 'user');
  const latestQuestion = userMessages.length > 0 
    ? userMessages[userMessages.length - 1].content 
    : '';

  // Search for relevant FAQs
  const relevantFAQs = searchFAQ(latestQuestion, faqs, stage);
  const faqContext = formatFAQContext(relevantFAQs);

  // Build enhanced system prompt with FAQ context
  const enhancedSystemPrompt = `${systemPrompt}

${faqContext}

Use the Q&As above to inform your answer, but respond naturally to the user's specific question. Feel free to reference relevant points from the knowledge base when helpful.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: enhancedSystemPrompt,
        messages: messages || []
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: err })
      };
    }

    const data = await response.json();
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
}
