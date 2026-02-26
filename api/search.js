// beleidsbank-api/api/search.js
// Generic search (evidence-first):
// 1) Exact-first voor "artikel X" met strikte doc-filter als wet genoemd wordt
// 2) Fallback semantisch (VECTOR DB via Supabase RPC)
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

    const qWords = new Set(qn.split(" "));
    const tWords = new Set(tn.split(" "));

    // harde boost als "awb" in vraag en title bevat "algemene wet bestuursrecht"
    if (qWords.has("awb") && tn.includes("algemene wet bestuursrecht")) score += 50;

    // harde match op bekende IDs (fix voor rare titles)
    if (qWords.has("awb") && /bwbr0005537/i.test(d.id)) score += 100;
    if (qWords.has("omgevingswet") && /bwbr0037885/i.test(d.id)) score += 100;

    // algemene woord-overlap
    for (const w of tWords){
      if (w.length >= 4 && qWords.has(w)) score += 2;
    }

    if (!best || score > best.score){
      best = { id: d.id, title: d.title, score };
    }
  }

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
    // FORCED ROUTING (klein, direct effect)
    // -------------------------
    let forcedDetected = detected;
    const qn2 = normalizeText(q);

    // omgevingsplan => Omgevingswet
    if (!forcedDetected && qn2.includes("omgevingsplan")) {
      forcedDetected = { id: "BWBR0037885", title: "Omgevingswet", score: 999 };
    }

    // bestuursorgaan => Awb
    if (!forcedDetected && qn2.includes("bestuursorgaan")) {
      forcedDetected = { id: "BWBR0005537", title: "Awb", score: 999 };
    }

    // onrechtmatige daad => BW
    if (!forcedDetected && qn2.includes("onrechtmatige daad")) {
      forcedDetected = { id: "BWBR0033229", title: "Burgerlijk Wetboek Boek 6", score: 999 };
    }

    // -------------------------
    // EXACT-FIRST: "artikel X"
    // -------------------------
    const requestedArticle = extractRequestedArticle(q);
    if (requestedArticle) {
      const candidates = await supabaseExactArticleCandidates({
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_KEY,
        article: requestedArticle,
        docId: forcedDetected?.id || null
      });

      const exactHits = strictFilterExactArticle(candidates, requestedArticle);

      const qWords = new Set(normalizeText(q).split(" "));
      const explicitLawMentioned = qWords.has("awb") || qWords.has("omgevingswet");

      if (exactHits.length) {
        return res.status(200).json({
          ok: true,
          query: q,
          mode: "exact-article",
          detected_document: forcedDetected ? { id: forcedDetected.id, title: forcedDetected.title, score: forcedDetected.score } : null,
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
        return res.status(200).json({
          ok: true,
          query: q,
          mode: "exact-article-not-found",
          detected_document: forcedDetected ? { id: forcedDetected.id, title: forcedDetected.title, score: forcedDetected.score } : null,
          results: []
        });
      }
      // anders: val door naar semantisch
    }

    // -------------------------
    // DEFINITIE-PRIORITEIT (Awb art. 1:3)
    // -------------------------
    const qn = normalizeText(q);
    const isDefinitionQ =
      qn.startsWith("wat is ") ||
      qn.startsWith("wat betekent ") ||
      qn.includes(" definitie ") ||
      qn.startsWith("definieer ");

    if (isDefinitionQ && !requestedArticle) {
      const wantsBesluit =
        /\bbesluit\b/.test(qn) ||
        /\bbeschikking\b/.test(qn) ||
        /\bbeleidsregel\b/.test(qn) ||
        /\baanvraag\b/.test(qn);

      if (wantsBesluit) {
        const candidates = await supabaseExactArticleCandidates({
          supabaseUrl: SUPABASE_URL,
          serviceKey: SERVICE_KEY,
          article: "1:3",
          docId: "BWBR0005537" // Awb
        });

        const exactHits = strictFilterExactArticle(candidates, "1:3");
        if (exactHits.length) {
          return res.status(200).json({
            ok: true,
            query: q,
            mode: "definition-priority-awb-1:3",
            detected_document: { id: "BWBR0005537", title: "Awb", score: 999 },
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
      }
    }

    // -------------------------
    // SEMANTIC FALLBACK (VECTOR DB)
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
      return res.status(200).json({
        ok: true,
        query: q,
        mode: "semantic-error",
        detected_document: forcedDetected ? { id: forcedDetected.id, title: forcedDetected.title, score: forcedDetected.score } : null,
        results: [],
        note: "Embedding tijdelijk mislukt"
      });
    }

    const qvec = embJson.data[0].embedding;

    const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      },
      body: JSON.stringify({
        query_embedding: qvec,
        match_count: 12,
        doc_filter: forcedDetected?.id || null
      })
    });

    const rows = await rpcResp.json();

    if (!rpcResp.ok) {
      return res.status(200).json({
        ok: true,
        query: q,
        mode: "semantic-error",
        detected_document: forcedDetected ? { id: forcedDetected.id, title: forcedDetected.title, score: forcedDetected.score } : null,
        results: [],
        note: "Vector search tijdelijk mislukt"
      });
    }

    return res.status(200).json({
      ok: true,
      query: q,
      mode: "semantic",
      detected_document: forcedDetected ? { id: forcedDetected.id, title: forcedDetected.title, score: forcedDetected.score } : null,
      results: (rows || []).map((r,i)=>({
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
