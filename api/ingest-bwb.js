// beleidsbank-api/api/ingest-bwb.js
// Genereer chunks per artikel uit wetten.overheid.nl (BWB/BWBR)
// GET /api/ingest-bwb?id=BWBR0037885&limit=120&offset=0
//
// Vereist env:
// SUPABASE_URL
// SUPABASE_SERVICE_KEY
// OPENAI_API_KEY

const { createClient } = require("@supabase/supabase-js");

function safeInt(v, d){ const n = parseInt(v,10); return Number.isFinite(n)?n:d; }

function decodeHtml(s){
  return (s||"")
    .replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&")
    .replace(/&quot;/g,'"')
    .replace(/&#039;/g,"'")
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

// knip tekst op "Artikel X" blokken
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
    if (block.length > 40) blocks.push(block);
  }
  return blocks;
}

function articleLabel(docShort, block){
  const m = (block || "").match(/^Artikel\s+([0-9A-Za-z:.\-]+)/);
  const art = m?.[1] ? m[1].replace(".",":") : "";
  return art ? `${docShort} — Artikel ${art}` : `${docShort} — Artikel`;
}

async function embedOpenAI(text, apiKey){
  // kort houden: embeddings zijn duur. We embedden de hele artikeltekst (V1).
  const resp = await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000)
    })
  });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI embeddings failed ${resp.status}: ${raw.slice(0,200)}`);
  const json = JSON.parse(raw);
  return json.data?.[0]?.embedding;
}

module.exports = async (req, res) => {
  try{
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY missing" });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const id = (req.query.id || "").toString().trim();
    if (!/^BWBR/i.test(id)) {
      return res.status(400).json({ error: "Missing/invalid id. Use ?id=BWBR..." });
    }

    const limit = Math.min(300, Math.max(10, safeInt(req.query.limit, 120)));
    const offset = Math.max(0, safeInt(req.query.offset, 0));

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1) haal HTML van wetten.overheid.nl (actuele geconsolideerde tekst)
    const url = `https://wetten.overheid.nl/${encodeURIComponent(id)}`;
    const htmlResp = await fetch(url, { redirect: "follow" });
    const html = await htmlResp.text();
    if (!htmlResp.ok) {
      return res.status(500).json({ error: "Fetch wetten.overheid.nl failed", status: htmlResp.status });
    }

    const plain = decodeHtml(htmlToTextLite(html));
    const blocksAll = splitIntoArticleBlocks(plain);

    if (!blocksAll.length){
      return res.status(200).json({ error: "Geen artikelen gevonden", hint: "HTML structuur onverwacht", id });
    }

    const blocks = blocksAll.slice(offset, offset + limit);

    // docShort op basis van id (V1: later halen we echte titel op)
    const docShort = (id === "BWBR0005537") ? "Awb" : id;

    // 2) insert chunks
    let saved = 0;
    for (const block of blocks){
      const label = articleLabel(docShort, block);
      const embedding = await embedOpenAI(block, OPENAI_API_KEY);

      const row = {
        doc_id: id,
        label,
        text: block,
        source_url: url,
        embedding
      };

      const { error } = await supabase.from("chunks").insert(row);
      if (!error) saved++;
    }

    return res.status(200).json({
      ok: true,
      id,
      total_articles_found: blocksAll.length,
      blocks_prepared: blocks.length,
      saved,
      next: `/api/ingest-bwb?id=${encodeURIComponent(id)}&limit=${limit}&offset=${offset + limit}`
    });

  } catch(e){
    return res.status(500).json({ error: "ingest-bwb crashed", details: String(e?.message || e) });
  }
};
