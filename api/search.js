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
        .trim();
    }

    function dedupeRows(rows) {
      const map = new Map();

      for (const r of rows || []) {
        if (!r) continue;
        const key = `${r.doc_id || ""}||${(r.label || "").toLowerCase()}`;
        if (!map.has(key)) {
          map.set(key, r);
        }
      }

      return Array.from(map.values());
    }

    function extractTokens(input) {
      const stop = new Set([
        "wat","is","een","de","het","van","in","op","om","te","met","voor","bij","en","of",
        "aan","tot","dan","dit","dat","als","uit","door","wordt","werd","zijn","heeft",
        "hebben","wanneer","welke","welk","wie","waar","waarom","hoe","leg","uit","betekent",
        "artikel","awb","omgevingswet","bal","kun","je","een","korte","samenvatting","geven"
      ]);

      return input
        .replace(/[?.,;()]/g, " ")
        .split(/\s+/)
        .map(x => x.trim())
        .filter(Boolean)
        .filter(x => x.length >= 3)
        .filter(x => !stop.has(x));
    }

    function detectLaw(input) {
      const s = (input || "").toLowerCase();

      if (s.includes("omgevingswet")) return DOCS.omgevingswet;
      if (s.includes("awb") || s.includes("algemene wet bestuursrecht")) return DOCS.awb;
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

    async function queryChunks({ docId = null, labelLike = null, textLike = null, limit = 10 }) {
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

    function rank(rows, { question = "", keyword = "", preferredDocId = null }) {
      const qLower = (question || "").toLowerCase();
      const kw = (keyword || "").toLowerCase();

      return dedupeRows(rows)
        .map(r => {
          let score = 0;

          const label = (r.label || "").toLowerCase();
          const text = cleanText(r.text || "").toLowerCase();

          if (preferredDocId && r.doc_id === preferredDocId) score += 40;
          if (kw && text.includes(kw)) score += 15;
          if (kw && label.includes(kw)) score += 10;

          if (text.includes("wordt verstaan")) score += 20;
          if (text.includes("schriftelijke beslissing")) score += 20;
          if (text.includes("bestuursorgaan")) score += 10;

          // definities in Awb hoofdstuk 1
          if (r.doc_id === DOCS.awb.id && /artikel 1[:.]/.test(label)) score += 10;

          // sterke boost voor omgevingsvergunning → Omgevingswet 5:1
          if (qLower.includes("omgevingsvergunning") && r.doc_id === DOCS.omgevingswet.id) score += 40;
          if (qLower.includes("omgevingsvergunning") && label.includes("5:1")) score += 120;
          if (qLower.includes("omgevingsvergunning") && text.includes("zonder omgevingsvergunning")) score += 80;

          // in werking treden / bekendmaking → Awb 3:40
          if ((qLower.includes("in werking") || qLower.includes("bekendgemaakt")) && r.doc_id === DOCS.awb.id) score += 30;
          if ((qLower.includes("in werking") || qLower.includes("bekendgemaakt")) && label.includes("3:40")) score += 120;
          if ((qLower.includes("in werking") || qLower.includes("bekendgemaakt")) && text.includes("niet in werking treedt voordat het is bekendgemaakt")) score += 100;

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

    // -----------------------------------
    // 1) EXACT ARTIKEL LOOKUP
    // -----------------------------------
    const articleMatch = q.match(/\bartikel\s+([0-9a-z:.]+)\b/i);
    const law = detectLaw(q);

    if (articleMatch) {
      const articleRaw = articleMatch[1];
      const variants = normalizeArticleVariants(articleRaw);

      let articleRows = [];

      if (law) {
        for (const v of variants) {
          articleRows.push(...await queryChunks({
            docId: law.id,
            labelLike: `artikel ${v}`,
            limit: 15
          }));
        }

        const rankedExact = rank(articleRows, {
          question: q,
          preferredDocId: law.id
        });

        if (rankedExact.length > 0) {
          return res.status(200).json({
            ok: true,
            results: rankedExact.slice(0, 8)
          });
        }
      } else {
        for (const v of variants) {
          articleRows.push(...await queryChunks({
            labelLike: `artikel ${v}`,
            limit: 25
          }));
        }

        const rankedAny = rank(articleRows, { question: q });

        // unambiguous: maar 1 unieke wet
        const distinctDocs = [...new Set(rankedAny.map(r => r.doc_id).filter(Boolean))];

        if (rankedAny.length > 0 && distinctDocs.length === 1) {
          return res.status(200).json({
            ok: true,
            results: rankedAny.slice(0, 8)
          });
        }

        // ambiguous: meerdere wetten
        if (rankedAny.length > 1 && distinctDocs.length > 1) {
          const top = rankedAny.slice(0, 5).map(r => r.label).join(", ");

          return res.status(200).json({
            ok: true,
            ambiguous: true,
            question: "Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
            options: rankedAny.slice(0, 5).map(r => ({
              title: r.label,
              doc_id: r.doc_id
            })),
            results: []
          });
        }
      }
    }

    // -----------------------------------
    // 2) NORMALE KEYWORD SEARCH
    // -----------------------------------
    const tokens = extractTokens(q);
    const primaryToken = tokens[0] || "";
    const secondaryToken = tokens[1] || "";
    const preferredLaw = detectLaw(q);

    let rows = [];

    // Eerst prioriteitswetten
    rows.push(...await queryChunks({
      docId: DOCS.awb.id,
      textLike: primaryToken,
      limit: 12
    }));

    rows.push(...await queryChunks({
      docId: DOCS.omgevingswet.id,
      textLike: primaryToken,
      limit: 12
    }));

    rows.push(...await queryChunks({
      docId: DOCS.bal.id,
      textLike: primaryToken,
      limit: 8
    }));

    if (secondaryToken) {
      rows.push(...await queryChunks({
        docId: DOCS.awb.id,
        textLike: secondaryToken,
        limit: 8
      }));

      rows.push(...await queryChunks({
        docId: DOCS.omgevingswet.id,
        textLike: secondaryToken,
        limit: 8
      }));
    }

    // Fallback: hele database
    if (rows.length < 10 && primaryToken) {
      rows.push(...await queryChunks({
        textLike: primaryToken,
        limit: 20
      }));
    }

    if (rows.length < 10 && secondaryToken) {
      rows.push(...await queryChunks({
        textLike: secondaryToken,
        limit: 20
      }));
    }

    const ranked = rank(rows, {
      question: q,
      keyword: primaryToken,
      preferredDocId: preferredLaw?.id || null
    });

    return res.status(200).json({
      ok: true,
      results: ranked.slice(0, 15)
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      results: []
    });
  }
};
