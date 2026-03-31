module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(200).json({ ok: true, results: [] });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json"
    };

    const qRaw = (req.query.q || "").toString().trim();
    const q = qRaw.toLowerCase();

    if (!q) {
      return res.status(200).json({ ok: true, results: [] });
    }

    function clean(t) {
      return (t || "")
        .replace(/\s+/g, " ")
        .replace(/Toon relaties in LiDO/gi, "")
        .replace(/Maak een permanente link/gi, "")
        .replace(/Toon wetstechnische informatie/gi, "")
        .replace(/Druk het regelingonderdeel af/gi, "")
        .replace(/Sla het regelingonderdeel op/gi, "")
        .trim();
    }

    function detectLaw(text) {
      if (text.includes("awb")) return "Awb";
      if (text.includes("omgevingswet")) return "Omgevingswet";
      if (text.includes("bal")) return "Bal";
      if (text.includes("bbl")) return "Bbl";
      if (text.includes("bkl")) return "Bkl";
      if (text.includes("wkb")) return "Wkb";
      return null;
    }

    function detectArticle(text) {
      const m =
        text.match(/artikel\s+([0-9a-zA-Z:.\-]+)/i) ||
        text.match(/\bart\.?\s*([0-9a-zA-Z:.\-]+)/i) ||
        text.match(/\b([0-9]+(?::|\.)[0-9a-zA-Z.\-]+)\b/);
      return m?.[1] || null;
    }

    const lawName = detectLaw(q);
    const article = detectArticle(q);

    // 1) DIRECTE ARTIKELZOEKING
    if (article) {
      let url =
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id,law_name,article_number` +
        `&article_number=eq.${encodeURIComponent(article)}`;

      if (lawName) {
        url += `&law_name=eq.${encodeURIComponent(lawName)}`;
      }

      url += `&limit=10`;

      const resp = await fetch(url, { headers });
      const rows = await resp.json();

      if (Array.isArray(rows) && rows.length) {
        const results = rows.map(r => ({
          id: r.id,
          label: r.label,
          text: clean(r.text),
          excerpt: clean(r.text),
          source_url: r.source_url,
          doc_id: r.doc_id,
          law_name: r.law_name,
          article_number: r.article_number
        }));

        return res.status(200).json({ ok: true, results });
      }
    }

    // 2) KEYWORD SEARCH OP TEXT + LAW
    let keywordResults = [];
    try {
      let url =
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id,law_name,article_number` +
        `&text=ilike.*${encodeURIComponent(q.split(" ").join("*"))}*` +
        `&limit=15`;

      if (lawName) {
        url += `&law_name=eq.${encodeURIComponent(lawName)}`;
      }

      const resp = await fetch(url, { headers });
      const json = await resp.json();

      if (Array.isArray(json)) keywordResults = json;
    } catch {}

    // 3) VECTOR SEARCH
    let vectorResults = [];
    try {
      const embedResp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: qRaw
        })
      });

      const embedJson = await embedResp.json();
      const embedding = embedJson?.data?.[0]?.embedding;

      if (embedding) {
        const vectorResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_chunks`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query_embedding: embedding,
            match_count: 15
          })
        });

        const json = await vectorResp.json();
        if (Array.isArray(json)) {
          vectorResults = lawName
            ? json.filter(r => (r.label || "").toLowerCase().includes(lawName.toLowerCase()))
            : json;
        }
      }
    } catch {}

    // 4) COMBINEREN + DEDUPEN
    const seen = new Set();
    const combined = [...keywordResults, ...vectorResults].filter(r => {
      const key = `${r.doc_id || ""}-${r.label || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const results = combined.slice(0, 15).map(r => ({
      id: r.id,
      label: r.label,
      text: clean(r.text),
      excerpt: clean(r.text),
      source_url: r.source_url,
      doc_id: r.doc_id
    }));

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(200).json({ ok: true, results: [] });
  }
};
