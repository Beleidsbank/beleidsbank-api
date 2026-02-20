// beleidsbank-api/api/search.js
// Generic search voor Beleidsbank:
// 1) exact-first voor "artikel X" (met document-detectie op basis van documents.title)
// 2) fallback semantisch (embeddings + cosine)
//
// Let op: semantisch deel is MVP en schaalt niet naar "alle wetten" (limit=5000).
// Exact-first is wél generiek en werkt voor elke geïngeste wet.

function safeJsonParse(s){ try{ return JSON.parse(s); } catch { return null; } }
function escapeRegExp(str){ return (str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeText(s){
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[’']/g, "")      // apostrof varianten
    .replace(/[^a-z0-9\s:.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRequestedArticle(q) {
  const s = normalizeText(q);

  // match: "artikel 5.1", "art. 5.1", "artikel 5:1", "artikel 16:25a"
  const m = s.match(/\b(artikel|art\.)\s+([0-9]{1,3}(?:[.:][0-9]{1,3}[a-z]?)?(?:[a-z])?)\b/);
  if (!m) return null;

  let art = m[2].trim();
  art = art.replace(".", ":"); // normalize 5.1 -> 5:1
  return art;
}

function scoreDocMatch(questionNorm, docTitleNorm){
  // simpele maar robuuste scoring:
  // +3 als volledige titel als substring voorkomt
  // +1 per woord (>=4 chars) dat in vraag voorkomt
  if (!docTitleNorm) return 0;
  let score = 0;

  if (questionNorm.includes(docTitleNorm)) score += 3;

  const words = docTitleNorm.split(" ").filter(w => w.length >= 4);
  for (const w of words){
    if (questionNorm.includes(w)) score += 1;
  }
  return score;
}

async function supabaseFetchDocuments({ supabaseUrl, serviceKey }){
  const url = `${supabaseUrl}/rest/v1/documents?select=id,title&limit=10000`;
  const r = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Supabase documents fetch failed: ${JSON.stringify(data).slice(0,300)}`);
  return Array.isArray(data) ? data : [];
}

function pickBestDocumentId(question, documents){
  const qn = normalizeText(question);
  let best = null;

  for (const d of documents){
    const titleNorm = normalizeText(d.title || "");
    const s = scoreDocMatch(qn, titleNorm);
    if (!best || s > best.score){
      best = { id: d.id, title: d.title, score: s };
    }
  }

  // drempel: score >= 2 betekent "redelijk zeker"
  if (best && best.score >= 2) return best;
  return null;
}

async function supabaseExactArticleCandidates({ supabaseUrl, serviceKey, article, docId }) {
  // Kandidaten ophalen (ruimer), daarna strikte filtering.
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
  // Match "Artikel 5:1" maar NIET "Artikel 5:10" / "Artikel 15:10"
  // en accepteer ook "Artikel 5:1." (punt erachter)
  const art = escapeRegExp(article);
  const re = new RegExp(`\\bArtikel\\s+${art}(?:(?![0-9A-Za-z]).|$)`, "i");
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

    // -------------------------
    // Load docs index (generic)
    // -------------------------
    const documents = await supabaseFetchDocuments({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });
    const bestDoc = pickBestDocumentId(q, documents); // {id,title,score} of null

    // -------------------------
    // 0) EXACT-FIRST: "artikel X"
    // -------------------------
    const requestedArticle = extractRequestedArticle(q);
    if (requestedArticle) {
      const candidates = await supabaseExactArticleCandidates({
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_KEY,
        article: requestedArticle,
        docId: bestDoc?.id || null
      });

      const exactHits = strictFilterExactArticle(candidates, requestedArticle);

      if (exactHits.length) {
        return res.status(200).json({
          ok: true,
          query: q,
          mode: "exact-article",
          detected_document: bestDoc ? { id: bestDoc.id, title: bestDoc.title, score: bestDoc.score } : null,
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

      // Geen hit -> laat semantisch proberen
    }

    // -------------------------
    // 1) Embedding (semantic fallback)
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
    // 2) Fetch chunks (MVP)
    // TIP: als bestDoc bekend is, filter op doc_id om veel sneller/zuiverder te zoeken
    // -------------------------
    const chunkUrl = bestDoc?.id
      ? `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding&doc_id=eq.${encodeURIComponent(bestDoc.id)}&limit=5000`
      : `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding&limit=5000`;

    const rowsResp = await fetch(chunkUrl, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });

    const rows = await rowsResp.json();
    if (!rowsResp.ok) {
      return res.status(500).json({ error: "Supabase fetch failed", details: rows });
    }

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

    const qLower = q.toLowerCase();

    const ranked = rows
      .map(r=>{
        const emb = toVec(r.embedding);
        if(!emb) return null;

        let sim = cosine(qvec, emb);

        const txt = (r.text||"").toLowerCase();

        if(qLower.includes("wat is") && txt.includes("wordt verstaan")) sim += 0.7;

        return {...r, similarity: sim};
      })
      .filter(Boolean)
      .sort((a,b)=>b.similarity-a.similarity)
      .slice(0,8);

    return res.status(200).json({
      ok: true,
      query: q,
      mode: "semantic",
      detected_document: bestDoc ? { id: bestDoc.id, title: bestDoc.title, score: bestDoc.score } : null,
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
