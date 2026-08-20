/**
 * faq-source.js — the single source of truth for how a FAQ becomes embeddable text.
 *
 * embed.js and verify-vectors.js both use this, so the string that gets embedded and
 * the string that gets hashed for verification can never drift apart. If you change
 * buildInput(), every stored hash changes and verify-vectors.js will (correctly)
 * demand a re-run of embed.js.
 */

const crypto = require('crypto');

const MAX_INPUT_CHARS = 2000;

// Tolerant XML parse (handles CDATA) — same shape embed.js has always used.
// Line endings must never affect the embedded text or its hash: git checks this
// file out with CRLF on Windows and LF elsewhere, so without this a FAQ containing
// a newline hashes differently per platform and verify-vectors.js reports it stale
// forever, whoever last ran embed.js.
function normalizeEol(s) {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseFaqs(xml) {
  const faqs = [];
  xml = normalizeEol(xml);
  const blocks = xml.match(/<faq\b[^>]*>[\s\S]*?<\/faq>/g) || [];
  for (const b of blocks) {
    const id  = (b.match(/<faq[^>]*\bid="([^"]+)"/) || [])[1] || '';
    const get = (tag) => {
      const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      if (!m) return '';
      return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
    };
    const q = get('question'), a = get('answer');
    if (id && q && a) faqs.push({ id, question: q, answer: a, keywords: get('keywords') });
  }
  return faqs;
}

// What we actually send to the embedding model: question + keywords + answer.
function buildInput(f) {
  return `${f.question}\nKeywords: ${f.keywords}\n${f.answer}`.slice(0, MAX_INPUT_CHARS);
}

// Short content fingerprint. 16 hex chars is ~64 bits — far more than enough to
// notice an edited answer, and it keeps faq_vectors.json from growing noticeably.
function hashInput(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function hashFaq(f) {
  return hashInput(buildInput(f));
}

module.exports = { parseFaqs, buildInput, hashInput, hashFaq, normalizeEol, MAX_INPUT_CHARS };
