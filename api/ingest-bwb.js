// beleidsbank-api/api/ingest-bwb.js
// Snelle generieke ingest voor landelijke wetgeving (BWBR) via wetten.overheid.nl
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

// split op "Artikel X" blokken
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
  // 1 API call met meerdere inputs = veel sneller
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

async function supabaseInsertChunks({ supabaseUrl, serviceKey, rows }){
  // Supabase REST insert
  const url = `${supabaseUrl}/rest/v1/chunks`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Prefer": "return=minimal"
    },
    body: JSON.stringify(rows)
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase insert failed ${resp.status}: ${text.slice(0,300)}`);
  }
}

module.exports = async (req, res) => {
  try{
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY missing" });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const id = (req.query.id || "").toString().trim();
    if (!/^BWBR/i.test(id)) {
      return res.status(400).json({ error: "Use ?id=BWBR..." });
    }

    // Vercel-safe defaults: klein beginnen
    const limit = Math.min(60, Math.max(5, safeInt(req.query.limit, 20)));
    const offset = Math.max(0, safeInt(req.query.offset, 0));

    // 1) haal geconsolideerde tekst HTML op
    const sourceUrl = `https://wetten.overheid.nl/${encodeURIComponent(id)}`;
    const htmlResp = await fetch(sourceUrl, { redirect:"follow" });
    const html = await htmlResp.text();
    if (!htmlResp.ok) return res.status(500).json({ error:"Fetch wetten.overheid.nl failed", status: htmlResp.status });

    const plain = decodeHtml(htmlToTextLite(html));
    const allBlocks = splitIntoArticleBlocks(plain);

    if (!allBlocks.length){
      return res.status(200).json({ error:"Geen artikelen gevonden", hint:"HTML structuur onverwacht", id });
    }

    const batch = allBlocks.slice(offset, offset + limit);
    const docShort = inferDocShort(id);

    // 2) embeddings in 1 call
    const embeddings = await embedBatch(batch, OPENAI_API_KEY);

    // 3) prepare rows
    const rows = batch.map((block, i) => ({
      doc_id: id,
      label: articleLabel(docShort, block),
      text: block,
      source_url: sourceUrl,
      embedding: embeddings[i]
    }));

    // 4) insert
    await supabaseInsertChunks({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, rows });

    return res.status(200).json({
      ok: true,
      id,
      total_articles_found: allBlocks.length,
      blocks_prepared: batch.length,
      saved: batch.length,
      next: `/api/ingest-bwb?id=${encodeURIComponent(id)}&limit=${limit}&offset=${offset + limit}`
    });

  } catch(e){
    return res.status(500).json({ error:"ingest-bwb crashed", details: String(e?.message || e) });
  }
};
