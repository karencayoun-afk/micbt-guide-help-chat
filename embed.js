#!/usr/bin/env node
/**
 * embed.js  —  Build-time embedding generator for the MiCBT FAQ database.
 *
 * WHAT IT DOES
 *   Reads micbt_faq_database.xml, sends each FAQ to an embedding model, and
 *   writes faq_vectors.json (one vector per FAQ, keyed by id). You run this
 *   ONCE locally whenever the FAQ database changes, then commit the JSON.
 *   At runtime, chat.js only embeds the user's question and compares it to
 *   these pre-computed vectors — so there is no vector database to host.
 *
 * HOW TO RUN
 *   1.  Get a Voyage AI API key (https://dashboard.voyageai.com/ -> API Keys).
 *   2.  export EMBEDDING_API_KEY="pa-..."
 *   3.  node embed.js
 *   4.  git add faq_vectors.json && git commit && push  (Netlify redeploys)
 *
 * COST: Voyage gives 200M free tokens; ~200 short FAQs uses a tiny fraction of that.
 *
 * PROVIDER: Voyage AI (pairs naturally with your Anthropic/Claude key).
 *   To switch providers, replace the body of embedBatch() only. The contract:
 *   take an array of strings, return an array of number[] vectors in the same
 *   order. Keep EMBED_MODEL / EMBED_DIM identical here and in chat.js so the
 *   stored vectors and query vectors match.
 */

const fs = require('fs');
const path = require('path');
const { parseFaqs, buildInput, hashInput } = require('./faq-source');

const EMBED_MODEL = 'voyage-4';
const EMBED_DIM   = 512;            // voyage-4 supports 256/512/1024/2048; 512 keeps JSON small
const XML_PATH    = path.join(__dirname, 'micbt_faq_database.xml');
const OUT_PATH    = path.join(__dirname, 'faq_vectors.json');
const API_KEY     = process.env.EMBEDDING_API_KEY;

if (!API_KEY) {
  console.error('ERROR: set EMBEDDING_API_KEY first  ->  export EMBEDDING_API_KEY="pa-..."');
  process.exit(1);
}

// --- embedding call (Voyage AI). Returns array of vectors in input order. ---
async function embedBatch(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts,
      input_type: 'document',          // these are the stored documents
      output_dimension: EMBED_DIM
    })
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Voyage returns { data: [{ embedding: [...], index: N }, ...] } — keep input order
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

(async () => {
  const xml = fs.readFileSync(XML_PATH, 'utf8');
  const faqs = parseFaqs(xml);
  console.log(`Parsed ${faqs.length} FAQs from ${path.basename(XML_PATH)}`);

  // What we embed: question + keywords + answer (truncated) — captures intent + content.
  // Defined in faq-source.js so verify-vectors.js hashes exactly what was embedded.
  const inputs = faqs.map(buildInput);

  const vectors = [];
  const BATCH = 50;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const slice = inputs.slice(i, i + BATCH);
    const embs = await embedBatch(slice);
    embs.forEach((v, j) => vectors.push({ id: faqs[i + j].id, v, h: hashInput(slice[j]) }));
    console.log(`  embedded ${Math.min(i + BATCH, inputs.length)}/${inputs.length}`);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    model: EMBED_MODEL, dimensions: EMBED_DIM, hashAlgo: 'sha256-16', count: vectors.length, vectors  // "dimensions" here is just a label in the output file
  }));
  const kb = (fs.statSync(OUT_PATH).size / 1024).toFixed(0);
  console.log(`Wrote ${path.basename(OUT_PATH)}  (${vectors.length} vectors, ${kb} KB)`);
  console.log('Run `node verify-vectors.js` to confirm the file matches the XML (the Netlify build does this too).');
})().catch(e => { console.error(e); process.exit(1); });
