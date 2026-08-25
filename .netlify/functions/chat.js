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
 *
 * There is no per-user question limit.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMBED_MODEL = 'voyage-4';                 // MUST match embed.js
const EMBED_DIM   = 512;                        // MUST match embed.js
const TOP_K       = 6;

// Retrieval-confidence thresholds (cosine similarity of the BEST match).
// Calibrated 2026-08-25 against the first real semantic traffic (voyage-4/512d).
// Deliberately off-topic questions and known-covered ones separated cleanly:
//
//   off-topic:  0.185 python script | 0.212 lasagne | 0.295 weather
//   -- gap --
//   covered:    0.388 "how do I do PMR"        | 0.421 "what do I do in Stage 1"
//               0.426 body sensations 1.3/1.4  | 0.472 anxiety vs fear vs anger
//               0.488 logged practice early    | 0.671 week 1 schedule question
//
// CONF_LOW sits in that gap. The previous 0.42 was a pre-launch guess and landed
// ABOVE the on-topic floor, so genuinely covered questions ("how do I do PMR")
// were told to hedge and point at support. CONF_HIGH was lowered for the same
// reason: at 0.55 only one question in nine cleared it, so nearly every real
// question carried the "match is only partial" caveat.
//
// The bands are still asymmetric on purpose. Over-hedging costs a little
// crispness; under-hedging is how the knowledge base gets stretched to fit a
// question it does not answer. When in doubt, hedge.
//
// n=9, so treat these as a first calibration rather than settled. Every question
// is logged with its score; revisit once there are a few hundred.
const CONF_HIGH = 0.47;   // >= this: strong match, answer normally
const CONF_LOW  = 0.33;   // <  this: weak match, tell Lumi to be candid / point onward

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
    VECTORS = data.vectors.map(({ id, v, h }) => {
      let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
      return { id, v, h, norm: Math.sqrt(n) || 1 };   // keep h: the freshness check needs it
    });
  } catch (e) { console.warn('vector load failed', e.message); VECTORS = false; }
  return VECTORS;
}

// ---------- vector freshness check (diagnostic) ----------
// The Netlify build runs verify-vectors.js and refuses to deploy a faq_vectors.json
// that no longer matches the XML. This is the belt-and-braces version: if a stale
// file reaches production anyway (build check bypassed, file edited in place), say so
// loudly in the function logs rather than quietly retrieving against outdated text.
// Purely diagnostic — it never changes what the bot answers.
let HEALTH_LOGGED = false;

function logVectorHealth(faqs, vectors) {
  if (HEALTH_LOGGED) return;
  HEALTH_LOGGED = true;
  try {
    if (!vectors || !vectors.length) return;
    // Must match buildInput() in faq-source.js, or every hash looks stale.
    // \r stripped to match normalizeEol() in faq-source.js — otherwise a CRLF
    // checkout makes every multi-line FAQ look stale.
    const nl = (t) => String(t == null ? '' : t).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const hashOf = (f) => crypto.createHash('sha256')
      .update(`${nl(f.question)}\nKeywords: ${nl(f.keywords)}\n${nl(f.answer)}`.slice(0, 2000), 'utf8')
      .digest('hex').slice(0, 16);

    const byId = new Map(vectors.map(v => [v.id, v]));
    const embeddable = Object.values(faqs).filter(f => f.question && f.answer);
    if (!embeddable.length) return;

    const missing = embeddable.filter(f => !byId.has(f.id)).map(f => f.id);
    const hashed = embeddable.filter(f => byId.get(f.id) && byId.get(f.id).h);
    const stale = hashed.filter(f => byId.get(f.id).h !== hashOf(f)).map(f => f.id);
    const orphans = vectors.map(v => v.id).filter(id => !faqs[id]);

    if (!hashed.length) {
      console.warn('[vectors] no content hashes present — freshness cannot be checked; re-run embed.js');
    } else if (missing.length || stale.length || orphans.length) {
      const show = (l) => l.slice(0, 8).join(', ') + (l.length > 8 ? ` +${l.length - 8} more` : '');
      console.warn(
        `[vectors] STALE faq_vectors.json — retrieval is matching outdated text. ` +
        `missing=${missing.length}${missing.length ? ` (${show(missing)})` : ''} ` +
        `stale=${stale.length}${stale.length ? ` (${show(stale)})` : ''} ` +
        `orphans=${orphans.length}${orphans.length ? ` (${show(orphans)})` : ''} ` +
        `-- run \`node embed.js\` and commit faq_vectors.json`
      );
    }
  } catch (e) { /* diagnostics must never break a reply */ }
}

// ---------- query embedding ----------
// Returns { vec } on success, or { reason } explaining the fallback. A bare null
// made a missing key indistinguishable from a broken one in the logs.
async function embedQuery(text) {
  const key = process.env.EMBEDDING_API_KEY;
  if (!key) return { reason: 'EMBEDDING_API_KEY is not set' };
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
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { reason: `Voyage API returned ${res.status}${body ? ` (${body.slice(0, 120)})` : ''}` };
  }
  const data = await res.json();
  const vec = data && data.data && data.data[0] && data.data[0].embedding;
  if (!vec) return { reason: 'Voyage API returned no embedding' };
  return { vec };
}

// Semantic retrieval degrades to keyword matching silently: the bot keeps answering,
// just far less accurately. That is worth one prominent line per cold start, because
// a missing EMBEDDING_API_KEY otherwise looks identical to a healthy deployment.
let MODE_LOGGED = false;

function logRetrievalMode(method, vectors, reason) {
  if (MODE_LOGGED) return;
  MODE_LOGGED = true;
  if (method === 'semantic') {
    console.log(`[retrieval] semantic active — ${EMBED_MODEL}/${EMBED_DIM}d over ${vectors.length} vectors`);
  } else {
    console.warn(
      `[retrieval] KEYWORD FALLBACK — semantic search is OFF. Reason: ${reason}. ` +
      `Answers still come from the FAQ database, but matching is by literal word overlap ` +
      `rather than meaning, and every reply is treated as a partial match.`
    );
  }
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
  logVectorHealth(faqs, vectors);
  let top, method, reason = '';
  if (vectors && vectors.length) {
    const q = await embedQuery(question);
    if (q && q.vec) { top = cosineTopK(q.vec, vectors, TOP_K); method = 'semantic'; }
    else {
      reason = (q && q.reason) || 'query embedding unavailable';
      top = keywordTopK(question, faqs, TOP_K); method = 'keyword';
    }
  } else {
    reason = 'faq_vectors.json missing or empty';
    top = keywordTopK(question, faqs, TOP_K); method = 'keyword';
  }
  logRetrievalMode(method, vectors, reason);
  // topScore is a cosine similarity (0..1) ONLY for the semantic path; the keyword
  // path uses an unbounded ad-hoc score, so we don't treat it as a confidence signal.
  const topScore = (method === 'semantic' && top.length) ? top[0].score : null;
  const results = top.map(t => faqs[t.id]).filter(Boolean);
  return { faqs: results, topScore, method, reason };
}

// Turn the best-match score into a confidence band. Keyword fallback can't be
// scored on the same scale, so it's treated as 'medium' (be honest, don't overreach).
function confidenceBand(topScore, method) {
  if (method !== 'semantic' || topScore == null) return 'medium';
  if (topScore >= CONF_HIGH) return 'high';
  if (topScore <  CONF_LOW)  return 'low';
  return 'medium';
}

function formatContext(faqs) {
  if (!faqs.length) return '';
  const body = faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
  return `Here are the most relevant Q&As from the MiCBT knowledge base:\n\n${body}\n\n`;
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

  const { messages = [], systemPrompt } = body;
  const userMsgs = messages.filter(m => m.role === 'user');
  const latest = userMsgs.length ? userMsgs[userMsgs.length - 1].content : '';

  // --- Question logging (privacy-conscious) ---
  // Logs ONLY the question text + timestamp, with NO user identifier (no IP, no name).
  // Goes to Netlify's function logs, which have limited retention by default.
  // Purpose: spot questions Lumi answers poorly so the FAQ database can be improved.
  // To turn logging off, set the comment flag below to false.
  const LOG_QUESTIONS = true;

  let relevant = [], topScore = null, method = 'none', reason = '';
  try {
    const r = await retrieve(latest);
    relevant = r.faqs; topScore = r.topScore; method = r.method; reason = r.reason;
  } catch (e) { console.warn('retrieve error', e.message); }

  const band = confidenceBand(topScore, method);

  // Logs the question, retrieval method, top score, and confidence band -- no user
  // identifier. The score is what you use to tune CONF_HIGH / CONF_LOW over time.
  if (LOG_QUESTIONS && latest) {
    const s = topScore == null ? 'n/a' : topScore.toFixed(3);
    // method carries its reason, so a keyword line explains itself without cross-referencing
    const m = method === 'keyword' && reason ? `keyword(${reason})` : method;
    console.log(`[Q ${new Date().toISOString()}] band=${band} score=${s} method=${m} :: ${String(latest).slice(0, 300)}`);
  }

  // When the knowledge base doesn't clearly cover the question, tell Lumi to be
  // candid and point onward rather than stretch weak matches into a confident answer.
  // This deliberately tempers the "be complete, don't defer" instruction in the
  // persona -- but only when retrieval is actually weak.
  let confidenceNote = '';
  if (band === 'low') {
    confidenceNote =
      `\n\nRETRIEVAL NOTE: The knowledge base did not return a strong match for this question. ` +
      `If the Q&As above don't actually address what the user asked, do not guess or stretch them to fit. ` +
      `Answer only what you can confidently support from the material, say plainly if you're not certain ` +
      `this is covered, and point the person to the Stage Guide for their current stage in the app, or to ` +
      `support@mindfulness.net.au for account or app issues.`;
  } else if (band === 'medium') {
    confidenceNote =
      `\n\nRETRIEVAL NOTE: The match is only partial. Rely on the Q&As above where they clearly apply, ` +
      `and be honest about any part of the question they don't cover rather than filling the gap with guesses.`;
  }

  const persona = systemPrompt || DEFAULT_PERSONA;
  const system = `${persona}\n\n${formatContext(relevant)}` +
    `Use the Q&As above to inform your answer, but respond naturally to the user's specific question.` +
    confidenceNote;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system, messages })
    });
    if (!response.ok) return { statusCode: response.status, body: JSON.stringify({ error: await response.text() }) };

    const data = await response.json();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
