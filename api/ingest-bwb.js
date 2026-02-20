// beleidsbank-api/api/ingest-bwb.js
// Generieke ingest voor landelijke wetgeving (BWBR) via wetten.overheid.nl
// GET /api/ingest-bwb?id=BWBR0037885&limit=20&offset=0
//
// Env nodig:
// SUPABASE_URL
// SUPABASE_SERVICE_KEY (of SUPABASE_SERVICE_ROLE_KEY)
// OPENAI_API_KEY

function safeInt(v, d){ const n = parseInt(v,10); return Number.isFinite(n)?n:d; }
function safeJsonParse(s){ try{ return JSON.parse(s); }catch{ return null; } }

function decodeHtml(s){
  return (s||"")
    .replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&")
    .replace(/&quot;/g,'"')
    .replace(/&#0*39;/g,"'")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">");
}

function htmlToTextLite(html){
  return (html||"")
    .replace(/<script[\s\S]*?<\/script>/gi,"")
    .replace(/<style[\s\S]*?<\/style>/gi,"")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6|tr|td|section|article)>/gi,"\n")
    .replace(/<[^>]+>/g,"\n")
    .replace(/\r/g,"")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}

function splitIntoArticleBlocks(plainText){
  const t = (plainText || "").replace(/\u00a0/g," ");
  const re = /(^|\n)(Artikel\s+\d+[a-zA-Z]?(?::\d+[a-zA-Z]?)?)/g;
  const matches = [...t.matchAll(re)];
  if (!matches.length) return [];

  const blocks = [];
  for (let i=0;i<matches.length;i++){
    const start = matches[i].index + (matches[i][1] ? matches[i][1].length : 0);
    const end = (i+1 < matches.length) ? matches[i+1].index : t.length;
    const block = t.slice(start, end).trim();
    if (block.length > 80) blocks.push(block);
  }
  return blocks;
}

function inferDocShort(id){
  const map = {
    "BWBR0005537": "Awb",
    "BWBR0037885": "Omgevingswet",
    "BWBR0041330": "Bal",
    "BWBR0041297": "Bbl",
    "BWBR0041313": "Bkl"
  };
  return map[id] || id;
}

function articleLabel(docShort, block){
  const m = (block || "").match(/^Artikel\s+([0-9A-Za-z:.\-]+)/);
  const art = m?.[1] ? m[1].replace(".",":") : "";
  return art ? `${docShort} — Artikel ${art}` : `${docShort} — Artikel`;
}

async function embedBatch(texts, apiKey){
  // ✅ Guard: OpenAI embeddings mogen niet met lege input
  if (!texts || texts.length === 0) return [];

  const resp = await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts.map(t => (t || "").slice(0, 8000))
    })
  });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI embeddings failed ${resp.status}: ${raw.slice(0,200)}`);
  const json = safeJsonParse(raw);
  const arr = json?.data?.map(x => x.embedding) || [];
  if (arr.length !== texts.length) throw new Error("Embedding count mismatch");
  return arr;
}

async function supabaseUpsertDocument({ supabaseUrl, serviceKey, doc }){
  const url = `${supabaseUrl}/rest/v1/documents?on_conflict=id`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(doc)
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase upsert documents failed ${resp.status}: ${text.slice(0,300)}`);
  }
}

function dedupeRowsByDocLabel(rows){
  const map = new Map();
  for (const r of rows){
    const key = `${r.doc_id}||${r.label}`;
    const prev = map.get(key);
    if (!prev){
      map.set(key, r);
      continue;
    }
    const prevLen = (prev.text || "").length;
    const curLen  = (r.text || "").length;
    if (curLen > prevLen){
      map.set(key, r);
    }
  }
  return Array.from(map.values());
}

async function supabaseUpsertChunks({ supabaseUrl, serviceKey, rows }){
  const uniqueRows = dedupeRowsByDocLabel(rows);

  // ✅ Guard: geen request doen als er niks te schrijven is
  if (uniqueRows.length === 0) return { sent: rows.length, unique: 0 };

  const url = `${supabaseUrl}/rest/v1/chunks?on_conflict=doc_id,label`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(uniqueRows)
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase upsert chunks failed ${resp.status}: ${text.slice(0,300)}`);
  }

  return { sent: rows.length, unique: uniqueRows.length };
}

module.exports = async (req, res) => {
  try{
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY (of SUPABASE_SERVICE_ROLE_KEY) missing" });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const id = (req.query.id || "").toString().trim();
    if (!/^BWBR/i.test(id)) {
      return res.status(400).json({ error: "Use ?id=BWBR..." });
    }

    const limit = Math.min(60, Math.max(5, safeInt(req.query.limit, 20)));
    const offset = Math.max(0, safeInt(req.query.offset, 0));

    const sourceUrl = `https://wetten.overheid.nl/${encodeURIComponent(id)}`;

    // 1) Fetch HTML
    const htmlResp = await fetch(sourceUrl, { redirect:"follow" });
    const html = await htmlResp.text();
    if (!htmlResp.ok) {
      return res.status(500).json({ error:"Fetch wetten.overheid.nl failed", status: htmlResp.status });
    }

    // 2) Extract + split
    const plain = decodeHtml(htmlToTextLite(html));
    const allBlocks = splitIntoArticleBlocks(plain);

    if (!allBlocks.length){
      return res.status(200).json({
        error:"Geen artikelen gevonden",
        hint:"HTML structuur onverwacht of tekst bevat geen 'Artikel ...' headings",
        id
      });
    }

    const batch = allBlocks.slice(offset, offset + limit);
    const docShort = inferDocShort(id);

    // ✅ Als batch leeg is: klaar, niet embeden, niet schrijven.
    if (!batch.length) {
      return res.status(200).json({
        ok: true,
        id,
        total_articles_found: allBlocks.length,
        blocks_prepared: 0,
        saved_or_updated: 0,
        done: true
      });
    }

    // 3) Upsert document (FK basis) — GEEN 'type'
    await supabaseUpsertDocument({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      doc: {
        id,
        title: docShort,
        source_url: sourceUrl
      }
    });

    // 4) Embeddings
    const embeddings = await embedBatch(batch, OPENAI_API_KEY);

    // 5) Build rows
    const rows = batch.map((block, i) => ({
      doc_id: id,
      label: articleLabel(docShort, block),
      text: block,
      source_url: sourceUrl,
      embedding: embeddings[i]
    }));

    // 6) Upsert chunks (dedupe-safe)
    const info = await supabaseUpsertChunks({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      rows
    });

    return res.status(200).json({
      ok: true,
      id,
      total_articles_found: allBlocks.length,
      blocks_prepared: batch.length,
      saved_or_updated: info.unique,
      deduped_in_batch: info.sent - info.unique,
      next: `/api/ingest-bwb?id=${encodeURIComponent(id)}&limit=${limit}&offset=${offset + limit}`
    });

  } catch(e){
    return res.status(500).json({
      error:"ingest-bwb crashed",
      details: String(e?.message || e)
    });
  }
};
