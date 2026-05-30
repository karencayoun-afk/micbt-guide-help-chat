/**
 * chat.js  —  Netlify Function for the MiCBT "Lumi" help assistant.
 *
 * FLOW (semantic retrieval, RAG-lite):
 *   1. Embed the user's latest question (same model/dims as embed.js).
 *   2. Cosine-compare it against the pre-computed FAQ vectors (faq_vectors.json).
 *   3. Take the top-K most relevant FAQs, pull their text from the XML.
 *   4. Inject those FAQs into the system prompt and answer via Claude.
 *
 * ENVIRONMENT VARIABLES (set in Netlify -> Site settings -> Environment):
 *   CLAUDE_API_KEY     — Anthropic key (answers).        Required.
 *   EMBEDDING_API_KEY  — Voyage AI key (query embedding). Required.
 *
 * If EMBEDDING_API_KEY is missing OR faq_vectors.json is absent, the function
 * automatically falls back to keyword matching so the bot still works.
 */

const fs = require('fs');
const path = require('path');

const EMBED_MODEL = 'voyage-4';                 // MUST match embed.js
const EMBED_DIM   = 512;                        // MUST match embed.js
const TOP_K       = 6;
const DAILY_LIMIT = 6;

// ---------- locate + load data files (resilient to Netlify cwd) ----------
function findFile(name) {
  const candidates = [
    path.join(process.cwd(), name),
    path.join(__dirname, name),
    path.join(__dirname, '..', '..', name),
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

let FAQS = null, VECTORS = null;   // cached across warm invocations

function loadFaqs() {
  if (FAQS) return FAQS;
  FAQS = {};
  const p = findFile('micbt_faq_database.xml');
  if (!p) { console.warn('FAQ xml not found'); return FAQS; }
  const xml = fs.readFileSync(p, 'utf8');
  const blocks = xml.match(/<faq\b[^>]*>[\s\S]*?<\/faq>/g) || [];
  for (const b of blocks) {
    const id = (b.match(/<faq[^>]*\bid="([^"]+)"/) || [])[1];
    const get = (tag) => {
      const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      if (!m) return '';
      return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
    };
    if (!id) continue;
    FAQS[id] = {
      id, question: get('question'), answer: get('answer'),
      keywords: get('keywords'), category: get('category'), source: (b.match(/source="([^"]+)"/) || [])[1] || ''
    };
  }
  return FAQS;
}

function loadVectors() {
  if (VECTORS !== null) return VECTORS;
  const p = findFile('faq_vectors.json');
  if (!p) { VECTORS = false; return VECTORS; }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    // pre-compute norms for fast cosine
    VECTORS = data.vectors.map(({ id, v }) => {
      let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
      return { id, v, norm: Math.sqrt(n) || 1 };
    });
  } catch (e) { console.warn('vector load failed', e.message); VECTORS = false; }
  return VECTORS;
}

// ---------- query embedding ----------
async function embedQuery(text) {
  const key = process.env.EMBEDDING_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text,
      input_type: 'query',           // matches the 'document' type used in embed.js
      output_dimension: EMBED_DIM
    })
  });
  if (!res.ok) { console.warn('query embed failed', res.status); return null; }
  const data = await res.json();
  return data.data[0].embedding;
}

function cosineTopK(qVec, vectors, k) {
  let qn = 0; for (let i = 0; i < qVec.length; i++) qn += qVec[i] * qVec[i];
  qn = Math.sqrt(qn) || 1;
  const scored = vectors.map(({ id, v, norm }) => {
    let dot = 0; for (let i = 0; i < v.length; i++) dot += qVec[i] * v[i];
    return { id, score: dot / (qn * norm) };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

// ---------- keyword fallback (used if embeddings unavailable) ----------
function keywordTopK(question, faqs, k) {
  const ql = question.toLowerCase();
  const words = ql.split(/\W+/).filter(w => w.length > 3);
  const scored = Object.values(faqs).map(f => {
    let s = 0;
    (f.keywords || '').split(',').forEach(kw => { if (kw.trim() && ql.includes(kw.trim().toLowerCase())) s += 3; });
    words.forEach(w => { if ((f.question || '').toLowerCase().includes(w)) s += 1;
                         if ((f.answer || '').toLowerCase().includes(w)) s += 0.4; });
    return { id: f.id, score: s };
  });
  return scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

async function retrieve(question) {
  const faqs = loadFaqs();
  const vectors = loadVectors();
  let top;
  if (vectors && vectors.length) {
    const qVec = await embedQuery(question);
    top = qVec ? cosineTopK(qVec, vectors, TOP_K) : keywordTopK(question, faqs, TOP_K);
  } else {
    top = keywordTopK(question, faqs, TOP_K);
  }
  return top.map(t => faqs[t.id]).filter(Boolean);
}

function formatContext(faqs) {
  if (!faqs.length) return '';
  const body = faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
  return `Here are the most relevant Q&As from the MiCBT knowledge base:\n\n${body}\n\n`;
}

// ---------- rate limit (in-memory; resets on cold start — see README) ----------
function rateLimit(userId, max) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}:${today}`;
  if (!global.qc) global.qc = {};
  const count = (global.qc[key] || 0) + 1;
  global.qc[key] = count;
  return { allowed: count <= max, used: count - 1, remaining: Math.max(0, max - count), limit: max };
}

const DEFAULT_PERSONA =
  `You are Lumi, a warm, calm guide for people using the MiCBT Guide app (a 10-week ` +
  `mindfulness-integrated CBT program for well-being). Answer using the knowledge base ` +
  `below, in your own warm words. Be concise and practical. Never give a medical diagnosis; ` +
  `for clinical concerns, gently suggest speaking with a healthcare professional or therapist.`;

exports.handler = async function (event) {
  const API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Claude API key not configured' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const userId = event.headers['x-forwarded-for']?.split(',')[0] || event.headers['client-ip'] || 'anon';
  const rl = rateLimit(userId, DAILY_LIMIT);
  if (!rl.allowed) {
    return { statusCode: 429, body: JSON.stringify({
      error: 'Daily question limit reached. Please try again tomorrow.',
      questionsUsed: rl.used, questionsRemaining: 0, dailyLimit: rl.limit }) };
  }

  const { messages = [], systemPrompt } = body;
  const userMsgs = messages.filter(m => m.role === 'user');
  const latest = userMsgs.length ? userMsgs[userMsgs.length - 1].content : '';

  let relevant = [];
  try { relevant = await retrieve(latest); }
  catch (e) { console.warn('retrieve error', e.message); }

  const persona = systemPrompt || DEFAULT_PERSONA;
  const system = `${persona}\n\n${formatContext(relevant)}` +
    `Use the Q&As above to inform your answer, but respond naturally to the user's specific question.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system, messages })
    });
    if (!response.ok) return { statusCode: response.status, body: JSON.stringify({ error: await response.text() }) };

    const data = await response.json();
    const out = { ...data, questionsUsed: rl.used, questionsRemaining: rl.remaining, dailyLimit: rl.limit };
    if (rl.remaining <= 2 && rl.remaining > 0) out.warning = `You have ${rl.remaining} question${rl.remaining === 1 ? '' : 's'} remaining today.`;
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
