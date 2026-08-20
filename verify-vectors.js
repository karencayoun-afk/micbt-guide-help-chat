#!/usr/bin/env node
/**
 * verify-vectors.js — fails loudly when faq_vectors.json no longer matches the FAQ database.
 *
 * WHY THIS EXISTS
 *   The vectors are generated once by embed.js and committed. Edit the XML without
 *   re-running embed.js and nothing complains: the file still parses, the count can
 *   still look right, and the bot keeps answering — it just retrieves against text
 *   that no longer exists. Wrong answers, no error. This script turns that silent
 *   failure into a build failure.
 *
 * WHAT IT CHECKS
 *   MISSING  — a FAQ in the XML with no vector at all (unreachable by semantic search)
 *   STALE    — a FAQ whose text changed since it was embedded (matched on its old wording)
 *   ORPHAN   — a vector whose FAQ no longer exists (dead weight, usually a deleted entry)
 *   Plus: model/dimension agreement, and that hashes are present at all.
 *
 * USAGE
 *   node verify-vectors.js          exit 0 = in sync, exit 1 = regenerate with embed.js
 *
 *   Runs automatically as the Netlify build command, so a commit that forgets
 *   embed.js fails to deploy instead of silently shipping stale retrieval.
 *   To ship anyway (not recommended), set ALLOW_STALE_VECTORS=1 in the Netlify
 *   environment — it downgrades the failure to a warning.
 */

const fs = require('fs');
const path = require('path');
const { parseFaqs, hashFaq } = require('./faq-source');

const XML_PATH = path.join(__dirname, 'micbt_faq_database.xml');
const VEC_PATH = path.join(__dirname, 'faq_vectors.json');

const EXPECT_MODEL = 'voyage-4';   // keep in step with embed.js / chat.js
const EXPECT_DIM   = 512;

function fail(lines) {
  const lenient = process.env.ALLOW_STALE_VECTORS === '1';
  console.error('');
  console.error(lenient ? 'WARNING: FAQ vectors are out of sync.' : 'ERROR: FAQ vectors are out of sync.');
  for (const l of lines) console.error('  ' + l);
  console.error('');
  console.error('  Fix: set EMBEDDING_API_KEY, run `node embed.js`, and commit faq_vectors.json.');
  console.error('');
  if (lenient) {
    console.error('  ALLOW_STALE_VECTORS=1 is set, so the build continues. Retrieval will');
    console.error('  match outdated text until the vectors are regenerated.');
    console.error('');
    return;
  }
  process.exit(1);
}

function main() {
  for (const [label, p] of [['micbt_faq_database.xml', XML_PATH], ['faq_vectors.json', VEC_PATH]]) {
    if (!fs.existsSync(p)) fail([`${label} is missing.`]);
  }

  const faqs = parseFaqs(fs.readFileSync(XML_PATH, 'utf8'));
  let data;
  try { data = JSON.parse(fs.readFileSync(VEC_PATH, 'utf8')); }
  catch (e) { return fail([`faq_vectors.json could not be parsed: ${e.message}`]); }

  const vectors = Array.isArray(data.vectors) ? data.vectors : [];
  if (!vectors.length) return fail(['faq_vectors.json contains no vectors.']);

  const problems = [];

  if (data.model && data.model !== EXPECT_MODEL) {
    problems.push(`model mismatch: vectors built with "${data.model}", code expects "${EXPECT_MODEL}".`);
  }
  const dims = new Set(vectors.map(v => (v.v || []).length));
  if (dims.size !== 1 || !dims.has(EXPECT_DIM)) {
    problems.push(`dimension mismatch: found ${[...dims].join(', ')}, expected ${EXPECT_DIM}.`);
  }

  // Vectors written before hashing existed can't be checked for staleness.
  const withHash = vectors.filter(v => v.h).length;
  if (withHash === 0) {
    return fail([
      'faq_vectors.json has no content hashes, so it cannot be checked against the XML.',
      'It predates this check and may or may not be current.',
    ]);
  }
  if (withHash !== vectors.length) {
    problems.push(`${vectors.length - withHash} of ${vectors.length} vectors have no content hash.`);
  }

  const byId = new Map(vectors.map(v => [v.id, v]));
  const faqIds = new Set(faqs.map(f => f.id));

  const missing = [], stale = [];
  for (const f of faqs) {
    const v = byId.get(f.id);
    if (!v) { missing.push(f.id); continue; }
    if (v.h && v.h !== hashFaq(f)) stale.push(f.id);
  }
  const orphans = vectors.map(v => v.id).filter(id => !faqIds.has(id));

  const show = (list) => list.slice(0, 12).join(', ') + (list.length > 12 ? `, +${list.length - 12} more` : '');
  if (missing.length) problems.push(`${missing.length} FAQ(s) have no vector — unreachable by semantic search: ${show(missing)}`);
  if (stale.length)   problems.push(`${stale.length} FAQ(s) changed since embedding — retrieval matches their old text: ${show(stale)}`);
  if (orphans.length) problems.push(`${orphans.length} vector(s) refer to FAQs that no longer exist: ${show(orphans)}`);

  if (problems.length) return fail(problems);

  console.log(`FAQ vectors OK — ${faqs.length} FAQs, ${vectors.length} vectors, all content hashes match.`);
}

main();
