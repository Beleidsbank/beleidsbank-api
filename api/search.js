module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY;
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
      const s = (text || "").toLowerCase();
      if (s.includes("awb")) return "Awb";
      if (s.includes("omgevingswet")) return "Omgevingswet";
      if (s.includes("bal")) return "Bal";
      if (s.includes("bbl")) return "Bbl";
      if (s.includes("bkl")) return "Bkl";
      if (s.includes("wkb")) return "Wkb";
      return null;
    }

    function detectArticle(text) {
      const m =
        text.match(/artikel\s+([0-9a-zA-Z:.\-]+)/i) ||
        text.match(/\bart\.?\s*([0-9a-zA-Z:.\-]+)/i) ||
        text.match(/\b([0-9]+(?::|\.)[0-9a-zA-Z.\-]+)\b/i);

      return m?.[1] ? m[1].replace(/\.$/, "") : null;
    }

    function normalizeArticle(article, lawName) {
      if (!article) return null;
      let a = article.trim();

      // Awb gebruikt meestal dubbele punten, zoals 1:3 en 2:1
      if (lawName === "Awb" && /^\d+\.\d+[a-zA-Z]?$/.test(a)) {
        a = a.replace(".", ":");
      }

      return a;
    }

    function extractKeywords(text) {
      const stopwords = new Set([
        "wat","is","een","de","het","van","volgens","wanneer","mag","kan",
        "zijn","er","over","volgt","uit","op","in","voor","bij","als","tegen",
        "door","met","dat","dit","dan","om","tot","of","en","te","mogelijk",
        "geef","samenvatting","samenvat","leg","uit","simpele","taal","korter",
        "regels","deze","dit","artikel"
      ]);

      return text
        .toLowerCase()
        .split(/[^a-z0-9:.\-]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => !stopwords.has(s))
        .filter(s => s.length >= 3);
    }

    const lawName = detectLaw(q);
    const articleRaw = detectArticle(q);
    const article = normalizeArticle(articleRaw, lawName);
    const keywords = extractKeywords(q);

    let articleResults = [];
    let keywordResults = [];
    let vectorResults = [];

    // 1. DIRECTE ARTIKELZOEKING
    if (article) {
      try {
        let url =
          `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id,law_name,article_number` +
          `&article_number=eq.${encodeURIComponent(article)}` +
          `&limit=5`;

        if (lawName) {
          url += `&law_name=eq.${encodeURIComponent(lawName)}`;
        }

        const resp = await fetch(url, { headers });
        const rows = await resp.json();

        if (Array.isArray(rows) && rows.length) {
          articleResults = rows;
        } else {
          // fallback: label exact-ish match
          let fallbackUrl =
            `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id,law_name,article_number` +
            `&label=ilike.*${encodeURIComponent(article)}*` +
            `&limit=5`;

          if (lawName) {
            fallbackUrl += `&law_name=eq.${encodeURIComponent(lawName)}`;
          }

          const fallbackResp = await fetch(fallbackUrl, { headers });
          const fallbackRows = await fallbackResp.json();

          if (Array.isArray(fallbackRows)) {
            articleResults = fallbackRows;
          }
        }
      } catch {}
    }

    // 2. KEYWORD SEARCH
    try {
      for (const word of keywords.slice(0, 5)) {
        let url =
          `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id,law_name,article_number` +
          `&or=(text.ilike.*${encodeURIComponent(word)}*,label.ilike.*${encodeURIComponent(word)}*)` +
          `&limit=10`;

        if (lawName) {
          url += `&law_name=eq.${encodeURIComponent(lawName)}`;
        }

        const resp = await fetch(url, { headers });
        const rows = await resp.json();

        if (Array.isArray(rows)) {
          keywordResults.push(...rows);
        }
      }
    } catch {}

    // 3. VECTOR SEARCH
    try {
      if (OPENAI_KEY) {
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
              match_count: 20
            })
          });

          const rows = await vectorResp.json();

          if (Array.isArray(rows)) {
            vectorResults = lawName
              ? rows.filter(r =>
                  (r.law_name || r.label || "").toLowerCase().includes(lawName.toLowerCase())
                )
              : rows;
          }
        }
      }
    } catch {}

    // 4. COMBINEREN + DEDUPEN
    const seen = new Set();
    const combined = [...articleResults, ...keywordResults, ...vectorResults].filter(r => {
      const key = `${r.doc_id || ""}-${r.label || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    function scoreResult(r) {
      let score = 0;

      const txt = (r.text || "").toLowerCase();
      const label = (r.label || "").toLowerCase();
      const rowLaw = (r.law_name || "").toLowerCase();
      const rowArticle = (r.article_number || "").toLowerCase();

      if (lawName && rowLaw === lawName.toLowerCase()) score += 10;
      if (lawName && label.includes(lawName.toLowerCase())) score += 4;

      if (article) {
        if (rowArticle === article.toLowerCase()) score += 30;
        else if (rowArticle.includes(article.toLowerCase())) score += 10;

        if (label.includes(article.toLowerCase())) score += 8;
      }

      for (const word of keywords) {
        if (txt.includes(word)) score += 4;
        if (label.includes(word)) score += 2;
      }

      // generieke definitie-signalen
      if (txt.includes("wordt verstaan")) score += 5;
      if (txt.includes("onder ") && txt.includes("wordt verstaan")) score += 3;
      if (txt.includes("schriftelijke beslissing")) score += 4;

      // generieke themasignalen
      if (q.includes("bezwaar")) {
        if (txt.includes("bezwaar")) score += 8;
        if (txt.includes("besluit")) score += 3;
      }

      if (q.includes("belanghebbende")) {
        if (txt.includes("belanghebbende")) score += 8;
        if (txt.includes("rechtstreeks")) score += 2;
      }

      if (q.includes("handhaven") || q.includes("handhaving")) {
        if (txt.includes("bestuursdwang")) score += 5;
        if (txt.includes("dwangsom")) score += 5;
        if (txt.includes("last onder")) score += 3;
      }

      if ((r.similarity || 0) > 0.7) score += 4;
      if ((r.similarity || 0) > 0.8) score += 4;

      return score;
    }

    const sorted = combined
      .map(r => ({ ...r, _score: scoreResult(r) }))
      .sort((a, b) => b._score - a._score);

    const results = sorted.slice(0, 4).map(r => ({
      id: r.id,
      label: r.label,
      text: clean(r.text),
      excerpt: clean(r.text),
      source_url: r.source_url,
      doc_id: r.doc_id,
      law_name: r.law_name,
      article_number: r.article_number
    }));

    return res.status(200).json({
      ok: true,
      results
    });
  } catch (e) {
    return res.status(200).json({
      ok: true,
      results: []
    });
  }
};
