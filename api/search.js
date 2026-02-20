// beleidsbank-api/api/search.js
// Generic search (evidence-first):
// 1) Exact-first voor "artikel X" met strikte doc-filter als wet genoemd wordt
// 2) Fallback semantisch (MVP)
//
// Output: { ok, query, mode, detected_document, results: [...] }

function safeJsonParse(s){ try{ return JSON.parse(s); } catch { return null; } }
function escapeRegExp(str){ return (str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeText(s){
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s:.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRequestedArticle(q) {
  const s = normalizeText(q);
  const m = s.match(/\b(artikel|art\.)\s+([0-9]{1,3}(?:[.:][0-9]{1,3}[a-z]?)?(?:[a-z])?)\b/);
  if (!m) return null;
  let art = m[2].trim();
  art = art.replace(".", ":"); // 5.1 -> 5:1
  return art;
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

// Heuristiek: als query expliciet een wet noemt, moet doc-detect hard werken.
// We scoren op:
// - exacte substring match op title (hoog)
// - match op afkorting als los woord (awb, woo, wkb, etc.) (hoog)
// - woord-overlap (middel)
function pickBestDocument(question, documents){
  const qn = normalizeText(question);

  let best = null;

  for (const d of documents){
    const title = (d.title || "").toString();
    const tn = normalizeText(title);
    if (!tn) continue;

    let score = 0;

    // 1) exacte title substring in vraag
    if (qn.includes(tn)) score += 10;

    // 2) afkorting match: neem eerste "woord" van title als kandidaat, plus veelgebruikte afkortingen
    // Specifiek: "awb" komt niet altijd als volledige title voor, maar wel als afkorting.
    // We doen generiek: als query een los woord heeft dat ook in title voorkomt, zwaar meetellen.
    const qWords = new Set(qn.split(" "));
    const tWords = new Set(tn.split(" "));

    // harde boost als "awb" in vraag en title bevat "algemene wet bestuursrecht"
    if (qWords.has("awb") && tn.includes("algemene wet bestuursrecht")) score += 50;

    // algemene woord-overlap
    for (const w of tWords){
      if (w.length >= 4 && qWords.has(w)) score += 2;
    }

    if (!best || score > best.score){
      best = { id: d.id, title: d.title, score };
    }
  }

  // Drempel:
  // - als query expliciet 'awb' bevat, verwachten we score >= 20 (door de harde boost)
  // - anders is >= 6 meestal ok
  const qnHasAwb = normalizeText(question).split(" ").includes("awb");
  const threshold = qnHasAwb ? 20 : 6;

  if (best && best.score >= threshold) return best;
  return null;
}

async function supabaseExactArticleCandidates({ supabaseUrl, serviceKey, article, docId }) {
  let url =
    `${supabaseUrl}/rest/v1/chunks` +
    `?select=id,doc_id,label,text,source_url` +
    `&label=ilike.${encodeURIComponent(`%Artikel%${article}%`)}` +
    `&limit=60`;

  if (docId) url += `&doc_id=eq.${encodeURIComponent(docId)}`;

  const r = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`Supabase exact lookup failed: ${JSON.stringify(data).slice(0,300)}`);
  return Array.isArray(data) ? data : [];
}

function strictFilterExactArticle(rows, article){
  const art = escapeRegExp(article);
  // match "Artikel 1:3" of "Artikel 1:3." maar niet 1:30 etc
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

    const documents = await supabaseFetchDocuments({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });
    const detected = pickBestDocument(q, documents);

    // -------------------------
    // EXACT-FIRST: "artikel X"
    // -------------------------
    const requestedArticle = extractRequestedArticle(q);
    if (requestedArticle) {
      // ✅ Als we een document detecteren: verplicht filteren op doc_id
      const candidates = await supabaseExactArticleCandidates({
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_KEY,
        article: requestedArticle,
        docId: detected?.id || null
      });

      const exactHits = strictFilterExactArticle(candidates, requestedArticle);

      // ✅ Als wet expliciet genoemd is (bv 'awb') en detected null -> we moeten NIET cross-wet antwoorden.
      const qWords = new Set(normalizeText(q).split(" "));
      const explicitLawMentioned = qWords.has("awb"); // later uitbreiden, maar dit fixt jouw issue direct

      if (exactHits.length) {
        return res.status(200).json({
          ok: true,
          query: q,
          mode: "exact-article",
          detected_document: detected ? { id: detected.id, title: detected.title, score: detected.score } : null,
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

      if (explicitLawMentioned) {
        // Als user "Awb" zegt maar we vinden niets exact, dan geen andere wetten teruggeven.
        return res.status(200).json({
          ok: true,
          query: q,
          mode: "exact-article-not-found",
          detected_document: detected ? { id: detected.id, title: detected.title, score: detected.score } : null,
          results: []
        });
      }
      // anders: val door naar semantisch
    }

    // -------------------------
    // SEMANTIC FALLBACK (MVP)
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
      return res.status(500).json({ error: "Embedding failed", details: embJson || embText });
    }
    const qvec = embJson.data[0].embedding;

    // filter op doc_id als detected
    const chunkUrl = detected?.id
      ? `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding&doc_id=eq.${encodeURIComponent(detected.id)}&limit=5000`
      : `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding&limit=5000`;

    const rowsResp = await fetch(chunkUrl, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });

    const rows = await rowsResp.json();
    if (!rowsResp.ok) return res.status(500).json({ error: "Supabase fetch failed", details: rows });

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

    const ranked = rows
      .map(r=>{
        const emb = toVec(r.embedding);
        if(!emb) return null;
        const sim = cosine(qvec, emb);
        return {...r, similarity: sim};
      })
      .filter(Boolean)
      .sort((a,b)=>b.similarity-a.similarity)
      .slice(0,8);

    return res.status(200).json({
      ok: true,
      query: q,
      mode: "semantic",
      detected_document: detected ? { id: detected.id, title: detected.title, score: detected.score } : null,
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
    return res.status(500).json({ error:"search crashed", details:String(e?.message||e) });
  }
};
