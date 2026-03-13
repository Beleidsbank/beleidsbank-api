module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing Supabase env",
        results: []
      });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    };

    let q = (req.query.q || "").toString().trim().toLowerCase();

    if (!q) {
      return res.status(200).json({
        ok: true,
        results: []
      });
    }

    const DOCS = {
      awb: { id: "BWBR0005537", name: "Awb" },
      omgevingswet: { id: "BWBR0037885", name: "Omgevingswet" },
      bal: { id: "BWBR0041330", name: "Bal" }
    };

    function cleanText(s) {
      return (s || "")
        .replace(/\s+/g, " ")
        .replace(/Toon relaties in LiDO/gi, "")
        .replace(/Maak een permanente link/gi, "")
        .replace(/Toon wetstechnische informatie/gi, "")
        .replace(/Druk het regelingonderdeel af/gi, "")
        .replace(/Sla het regelingonderdeel op/gi, "")
        .trim();
    }

    function dedupeRows(rows) {

      const map = new Map();

      for (const r of rows || []) {

        if (!r) continue;

        const key = `${r.doc_id || ""}|${(r.label || "").toLowerCase()}`;

        if (!map.has(key)) {
          map.set(key, r);
        }

      }

      return Array.from(map.values());

    }

    function detectLaw(input) {

      const s = (input || "").toLowerCase();

      if (s.includes("awb")) return DOCS.awb;
      if (s.includes("omgevingswet")) return DOCS.omgevingswet;
      if (s.includes("bal")) return DOCS.bal;

      return null;

    }

    function normalizeArticleVariants(articleRaw) {

      const base = (articleRaw || "").trim().replace(/\.$/, "");

      const set = new Set([base]);

      if (base.includes(".") && !base.includes(":")) {
        set.add(base.replace(/\./g, ":"));
      }

      if (base.includes(":") && !base.includes(".")) {
        set.add(base.replace(/:/g, "."));
      }

      return Array.from(set);

    }

    async function fetchJson(url) {

      const r = await fetch(url, { headers });

      const text = await r.text();

      let json = null;

      try { json = JSON.parse(text); } catch {}

      if (!r.ok || !Array.isArray(json)) return [];

      return json;

    }

    async function queryChunks({
      docId = null,
      labelLike = null,
      textLike = null,
      limit = 10
    }) {

      let url =
        `${SUPABASE_URL}/rest/v1/chunks` +
        `?select=id,label,text,source_url,doc_id` +
        `&limit=${limit}`;

      if (docId) {
        url += `&doc_id=eq.${docId}`;
      }

      if (labelLike) {
        url += `&label=ilike.*${encodeURIComponent(labelLike)}*`;
      }

      if (textLike) {
        url += `&text=ilike.*${encodeURIComponent(textLike)}*`;
      }

      return await fetchJson(url);

    }

    function rank(rows, { question = "", preferredDocId = null }) {

      const qLower = question.toLowerCase();

      return dedupeRows(rows)

        .map(r => {

          let score = 0;

          const label = (r.label || "").toLowerCase();
          const text = (r.text || "").toLowerCase();

          if (preferredDocId && r.doc_id === preferredDocId) score += 40;

          if (text.includes("wordt verstaan")) score += 20;
          if (text.includes("schriftelijke beslissing")) score += 20;

          if (qLower.includes("besluit") && text.includes("schriftelijke beslissing"))
            score += 40;

          if (qLower.includes("bestuursorgaan") && text.includes("openbaar gezag"))
            score += 40;

          if (qLower.includes("in werking") && text.includes("bekendgemaakt"))
            score += 40;

          return { ...r, _score: score };

        })

        .sort((a, b) => b._score - a._score)

        .map(({ _score, ...r }) => ({
          id: r.id,
          label: r.label,
          text: cleanText(r.text),
          excerpt: cleanText(r.text),
          source_url: r.source_url,
          doc_id: r.doc_id
        }));

    }

    // ----------------------------------------------------
    // 1 EXACT ARTICLE LOOKUP
    // ----------------------------------------------------

    const articleMatch = q.match(/\bartikel\s+([0-9a-z:.]+)\b/i);

    const law = detectLaw(q);

    if (articleMatch) {

      const articleRaw = articleMatch[1];

      const variants = normalizeArticleVariants(articleRaw);

      let rows = [];

      for (const v of variants) {

        rows.push(...await queryChunks({
          labelLike: `artikel ${v}`,
          limit: 40
        }));

      }

      const ranked = rank(rows, {
        question: q,
        preferredDocId: law?.id || null
      });

      if (!ranked.length) {

        return res.status(200).json({
          ok: true,
          results: []
        });

      }

      const distinctDocs =
        [...new Set(ranked.map(r => r.doc_id).filter(Boolean))];

      // wet niet gespecificeerd + meerdere wetten

      if (!law && distinctDocs.length > 1) {

        return res.status(200).json({
          ok: true,
          ambiguous: true,
          question: "Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
          options: ranked.slice(0,5).map(r => ({
            title: r.label,
            doc_id: r.doc_id
          })),
          results: []
        });

      }

      return res.status(200).json({
        ok: true,
        results: ranked.slice(0,8)
      });

    }

    // ----------------------------------------------------
    // 2 NORMAL SEARCH
    // ----------------------------------------------------

    const tokens = q
      .replace(/[?.,;()]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0,5);

    let rows = [];

    for (const token of tokens) {

      rows.push(...await queryChunks({
        textLike: token,
        limit: 10
      }));

    }

    const ranked = rank(rows, {
      question: q,
      preferredDocId: law?.id || null
    });

    return res.status(200).json({
      ok: true,
      results: ranked.slice(0,15)
    });

  }

  catch (e) {

    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      results: []
    });

  }

};
