// beleidsbank-api/api/search.js
// Search: exact-first voor "artikel X" + fallback naar embeddings/cosine.
// Fix: exact lookup mag NIET 5:10 matchen op query 5:1 (boundary matching).

function safeJsonParse(s){ try{ return JSON.parse(s); } catch { return null; } }

function escapeRegExp(str){
  return (str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRequestedArticle(q) {
  const s = (q || "").toLowerCase();

  // match: "artikel 5.1", "art. 5.1", "artikel 5:1", "artikel 16:25a"
  const m = s.match(/\b(artikel|art\.)\s+([0-9]{1,3}(?:[.:][0-9]{1,3}[a-z]?)?(?:[a-z])?)\b/);
  if (!m) return null;

  let art = m[2].trim();
  art = art.replace(".", ":"); // normalize 5.1 -> 5:1
  return art;
}

function inferDocIdFromQuery(qLower){
  if (qLower.includes("omgevingswet")) return "BWBR0037885";
  if (qLower.includes("awb") || qLower.includes("algemene wet bestuursrecht")) return "BWBR0005537";
  if (qLower.includes("bal")) return "BWBR0041330";
  if (qLower.includes("bbl")) return "BWBR0041297";
  if (qLower.includes("bkl")) return "BWBR0041313";
  return null;
}

async function supabaseExactArticleCandidates({ supabaseUrl, serviceKey, article, docId }) {
  // Kandidaten ophalen (iets ruimer), daarna strikte filtering in JS.
  let url =
    `${supabaseUrl}/rest/v1/chunks` +
    `?select=id,doc_id,label,text,source_url` +
    `&label=ilike.${encodeURIComponent(`%Artikel%${article}%`)}` +
    `&limit=50`;

  if (docId) url += `&doc_id=eq.${encodeURIComponent(docId)}`;

  const r = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });

  const data = await r.json();
  if (!r.ok) {
    throw new Error(`Supabase exact lookup failed: ${JSON.stringify(data).slice(0,300)}`);
  }

  return Array.isArray(data) ? data : [];
}

function strictFilterExactArticle(rows, article){
  // Doel: match "Artikel 5:1" maar NIET "Artikel 5:10" of "Artikel 15:10".
  // Regex: Artikel <spaties> 5:1 gevolgd door NIET een cijfer/letter (boundary)
  const art = escapeRegExp(article);
  const re = new RegExp(`\\bArtikel\\s+${art}(?![0-9A-Za-z])`, "i");
  return (rows || []).filter(r => re.test((r.label || "").toString()));
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://app.beleidsbank.nl");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" });
    if (!OPENAI_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "missing q" });

    const qLower = q.toLowerCase();

    // -------------------------
    // 0) EXACT-FIRST: "artikel X"
    // -------------------------
    const requestedArticle = extractRequestedArticle(q);
    if (requestedArticle) {
      const docId = inferDocIdFromQuery(qLower);

      const candidates = await supabaseExactArticleCandidates({
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_KEY,
        article: requestedArticle,
        docId
      });

      const exactHits = strictFilterExactArticle(candidates, requestedArticle);

      if (exactHits.length) {
        return res.status(200).json({
          ok: true,
          query: q,
          mode: "exact-article",
          results: exactHits.slice(0, 8).map((r, i) => ({
            id: r.id,
            n: i + 1,
            label: r.label,
            doc_id: r.doc_id,
            similarity: 999,
            source_url: r.source_url,
            excerpt: (r.text || "").slice(0, 1200)
          }))
        });
      }

      // Als we candidates hadden maar geen exact match, is dit waardevolle debug:
      // (laat dit gerust staan voor nu)
      if (candidates.length) {
        return res.status(200).json({
          ok: true,
          query: q,
          mode: "exact-article-not-found",
          requested: requestedArticle,
          hint: "Candidates matched substring; no strict Artikel <nr> match found. Likely artikel ontbreekt in chunks of label-format wijkt af.",
          candidates_preview: candidates.slice(0, 8).map(r => ({ id: r.id, label: r.label, doc_id: r.doc_id })),
          results: [] // force chat om te zeggen dat het niet gevonden is
        });
      }
      // anders: val door naar semantisch
    }

    // -------------------------
    // 1) embedding maken
    // -------------------------
    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: q
      })
    });

    const embText = await embResp.text();
    const embJson = safeJsonParse(embText);

    if (!embResp.ok || !embJson?.data?.[0]?.embedding) {
      return res.status(500).json({
        error: "Embedding failed",
        details: embJson || embText
      });
    }

    const qvec = embJson.data[0].embedding;

    // -------------------------
    // 2) chunks ophalen uit Supabase (MVP)
    // -------------------------
    const rowsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding&limit=5000`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`
        }
      }
    );

    const rows = await rowsResp.json();
    if (!rowsResp.ok) {
      return res.status(500).json({
        error: "Supabase fetch failed",
        details: rows
      });
    }

    // -------------------------
    // cosine similarity
    // -------------------------
    function cosine(a,b){
      let dot=0, na=0, nb=0;
      for(let i=0;i<a.length;i++){
        dot+=a[i]*b[i];
        na+=a[i]*a[i];
        nb+=b[i]*b[i];
      }
      return dot/(Math.sqrt(na)*Math.sqrt(nb));
    }

    function toVec(v){
      if(Array.isArray(v)) return v;
      if(typeof v==="string"){
        try { return JSON.parse(v); } catch { return null; }
      }
      return null;
    }

    // -------------------------
    // 3) ranking
    // -------------------------
    const ranked = rows
      .map(r=>{
        const emb = toVec(r.embedding);
        if(!emb) return null;

        let sim = cosine(qvec, emb);

        const txt = (r.text||"").toLowerCase();
        const label = (r.label||"").toLowerCase();

        if(qLower.includes("besluit") && txt.includes("besluit")) sim += 0.12;

        if(qLower.includes("wat is")){
          if(txt.includes("wordt verstaan")) sim += 0.7;
        }

        if(qLower.includes("besluit") && label.includes("1:3")) sim += 2.5;

        return {...r, similarity: sim};
      })
      .filter(Boolean)
      .sort((a,b)=>b.similarity-a.similarity)
      .slice(0,8);

    return res.status(200).json({
      ok: true,
      query: q,
      mode: "semantic",
      results: ranked.map((r,i)=>({
        id: r.id,
        n: i+1,
        label: r.label,
        doc_id: r.doc_id,
        similarity: r.similarity,
        source_url: r.source_url,
        excerpt: (r.text||"").slice(0,1200)
      }))
    });

  } catch(e){
    return res.status(500).json({
      error:"search crashed",
      details:String(e?.message||e)
    });
  }
};
