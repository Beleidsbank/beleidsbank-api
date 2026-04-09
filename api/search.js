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

    function isFormattingRequest(text) {
      const s = (text || "").toLowerCase();
      return (
        /\b\d+\s+regel(s)?\b/i.test(s) ||
        /\b\d+\s+zin(nen)?\b/i.test(s) ||
        /\b\d+\s+bullet(s)?\b/i.test(s)
      );
    }

    function detectArticle(text) {
      const s = (text || "").trim();

      if (isFormattingRequest(s)) return null;

      const m =
        s.match(/artikel\s+([0-9a-zA-Z:.\-]+)/i) ||
        s.match(/\bart\.?\s*([0-9a-zA-Z:.\-]+)/i) ||
        s.match(/\b([0-9]+(?::|\.)[0-9]+[a-zA-Z]?)\b/i);

      return m?.[1] ? m[1].replace(/\.$/, "") : null;
    }

    function normalizeArticle(article, lawName) {
      if (!article) return null;
      let a = article.trim();

      if (lawName === "Awb" && /^\d+\.\d+[a-zA-Z]?$/.test(a)) {
        a = a.replace(".", ":");
      }

      return a;
    }

    function extractKeywords(text) {
      const stopwords = new Set([
        "wat", "is", "een", "de", "het", "van", "volgens", "wanneer", "mag", "kan",
        "zijn", "er", "over", "uit", "op", "in", "voor", "bij", "als", "tegen",
        "door", "met", "dat", "dit", "dan", "om", "tot", "of", "en", "te",
        "mogelijk", "geef", "samenvatting", "samenvat", "leg", "uitleg", "uit",
        "simpele", "taal", "korter", "regels", "deze", "artikel", "maak", "hier",
        "nu", "simpeler", "voorbeeld", "regel", "zinnen", "zin", "bullets", "bullet",
        "vertel", "mij", "meer"
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

    // 1) Artikelzoeking
    if (article) {
      try {
        let url =
          `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id,law_name,article_number` +
          `&limit=20`;

        if (lawName) {
          url += `&law_name=eq.${encodeURIComponent(lawName)}`;
        }

        url += `&or=(article_number.eq.${encodeURIComponent(article)},label.ilike.*${encodeURIComponent(article)}*)`;

        const resp = await fetch(url, { headers });
        const rows = await resp.json();

        if (Array.isArray(rows)) {
          articleResults = rows;
        }
      } catch {}
    }

    // 2) Keyword search
    try {
      const conceptMap = [
        { terms: ["zorgvuldigheidsbeginsel", "zorgvuldigheid"], expand: ["zorgvuldig", "relevante", "feiten", "belangen"] },
        { terms: ["beschikking"], expand: ["beschikking", "besluit"] },
        { terms: ["belanghebbende"], expand: ["belanghebbende", "rechtstreeks"] },
        { terms: ["bezwaar"], expand: ["bezwaar", "besluit"] },
        { terms: ["handhaven", "handhaving"], expand: ["bestuursdwang", "dwangsom", "overtreding"] },
        { terms: ["onvolledige", "aanvraag"], expand: ["onvolledig", "aanvraag", "aanvullen"] },
        { terms: ["vergunning", "weigeren"], expand: ["weigeren", "vergunning"] },
        { terms: ["beleid", "afwijken"], expand: ["beleidsregel", "bijzondere", "omstandigheden", "onevenredig"] }
      ];

      let expandedKeywords = [...keywords];

      for (const row of conceptMap) {
        if (row.terms.some(t => q.includes(t))) {
          expandedKeywords.push(...row.expand);
        }
      }

      expandedKeywords = [...new Set(expandedKeywords)].slice(0, 8);

      for (const word of expandedKeywords) {
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

    // 3) Vector search
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
              ? rows.filter(r => {
                  const rowLaw = (r.law_name || "").toLowerCase();
                  const rowLabel = (r.label || "").toLowerCase();
                  return rowLaw === lawName.toLowerCase() || rowLabel.includes(lawName.toLowerCase());
                })
              : rows;
          }
        }
      }
    } catch {}

    // 4) Combine + dedupe
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

      if (article) {
        if (rowArticle === article.toLowerCase()) score += 10000;
        if (label.includes(`artikel ${article.toLowerCase()}`)) score += 5000;
      }

      if (lawName && rowLaw === lawName.toLowerCase()) score += 300;
      if (lawName && label.includes(lawName.toLowerCase())) score += 80;

      for (const word of keywords) {
        if (txt.includes(word)) score += 20;
        if (label.includes(word)) score += 10;
      }

      if (q.includes("zorgvuldigheidsbeginsel") || q.includes("zorgvuldigheid")) {
        if (rowLaw === "awb" && rowArticle === "3:2") score += 6000;
      }

      if (q.includes("beschikking")) {
        if (rowLaw === "awb" && rowArticle === "1:3") score += 6000;
      }

      if (q.includes("belanghebbende")) {
        if (rowLaw === "awb" && rowArticle === "1:2") score += 6000;
      }

      if (q.includes("bezwaar")) {
        if (rowLaw === "awb" && rowArticle === "1:5") score += 5000;
        if (rowLaw === "awb" && rowArticle === "7:1") score += 4500;
        if (rowLaw === "awb" && rowArticle === "6:3") score += 3500;
      }

      if (q.includes("beleid") && q.includes("afwijken")) {
        if (rowLaw === "awb" && rowArticle === "4:84") score += 7000;
      }

      if (txt.includes("wordt verstaan")) score += 20;
      if (txt.includes("schriftelijke beslissing")) score += 20;
      if ((r.similarity || 0) > 0.7) score += 20;
      if ((r.similarity || 0) > 0.8) score += 20;

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
