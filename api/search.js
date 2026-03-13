module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: "Missing Supabase env", results: [] });
    }

    let q = (req.query.q || "").toString().trim().toLowerCase();

    if (!q) {
      return res.status(200).json({ ok: true, results: [] });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    };

    const DOCS = {
      awb: "BWBR0005537",
      omgevingswet: "BWBR0037885"
    };

    function uniqById(rows) {
      const map = new Map();
      for (const r of rows || []) {
        if (r && r.id != null && !map.has(r.id)) map.set(r.id, r);
      }
      return Array.from(map.values());
    }

    function cleanText(s) {
      return (s || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function extractTokens(input) {
      const stop = new Set([
        "wat","is","een","de","het","van","in","op","om","te","met","voor","bij","en","of",
        "aan","tot","dan","dit","dat","als","uit","door","wordt","werd","zijn","heeft",
        "hebben","wanneer","welke","welk","wie","waar","waarom","hoe","leg","uit","betekent",
        "artikel","awb","omgevingswet"
      ]);

      return input
        .replace(/[?.,;:()]/g, " ")
        .split(/\s+/)
        .map(x => x.trim())
        .filter(Boolean)
        .filter(x => x.length >= 3)
        .filter(x => !stop.has(x))
        .sort((a, b) => b.length - a.length);
    }

    async function fetchJson(url) {
      const r = await fetch(url, { headers });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { ok: r.ok, status: r.status, json, text };
    }

    async function queryChunks({ docId = null, labelLike = null, textLike = null, limit = 10 }) {
      let url =
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&limit=${limit}`;

      if (docId) {
        url += `&doc_id=eq.${docId}`;
      }
      if (labelLike) {
        url += `&label=ilike.*${encodeURIComponent(labelLike)}*`;
      }
      if (textLike) {
        url += `&text=ilike.*${encodeURIComponent(textLike)}*`;
      }

      const out = await fetchJson(url);
      if (!out.ok || !Array.isArray(out.json)) return [];
      return out.json;
    }

    function detectLaw(input) {
      if (/\bawb\b/.test(input) || /algemene wet bestuursrecht/.test(input)) return DOCS.awb;
      if (/omgevingswet/.test(input)) return DOCS.omgevingswet;
      return null;
    }

    function normalizeArticleVariants(articleRaw) {
      const a = articleRaw.trim().replace(/\.$/, "");
      const variants = new Set([a]);

      if (a.includes(".") && !a.includes(":")) variants.add(a.replace(/\./g, ":"));
      if (a.includes(":") && !a.includes(".")) variants.add(a.replace(/:/g, "."));

      return Array.from(variants);
    }

    function rankRows(rows, { exactArticle = null, preferredDoc = null, keyword = null }) {
      const artNeedles = exactArticle ? normalizeArticleVariants(exactArticle) : [];
      const kw = (keyword || "").toLowerCase();

      return uniqById(rows)
        .map(r => {
          let score = 0;
          const label = (r.label || "").toLowerCase();
          const text = cleanText(r.text).toLowerCase();

          if (preferredDoc && r.doc_id === preferredDoc) score += 50;

          for (const art of artNeedles) {
            const a = art.toLowerCase();
            if (label.includes(`artikel ${a}`)) score += 80;
            else if (label.includes(a)) score += 20;
          }

          if (text.includes("wordt verstaan")) score += 20;
          if (text.includes("schriftelijke beslissing")) score += 20;
          if (text.includes("bestuursorgaan")) score += 10;

          if (kw && text.includes(kw)) score += 15;
          if (kw && label.includes(kw)) score += 10;

          if (/artikel 1[:.]/.test(label)) score += 8;

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

    // -------------------------
    // 1. EXACT ARTIKEL LOOKUP
    // -------------------------
    const articleMatch = q.match(/\bartikel\s+([0-9a-z:.]+)\b/i);
    const lawId = detectLaw(q);

    if (articleMatch) {
      const articleRaw = articleMatch[1];
      const variants = normalizeArticleVariants(articleRaw);

      let exactRows = [];

      if (lawId) {
        for (const v of variants) {
          exactRows.push(...await queryChunks({
            docId: lawId,
            labelLike: `artikel ${v}`,
            limit: 20
          }));
        }
      } else {
        for (const v of variants) {
          exactRows.push(...await queryChunks({
            labelLike: `artikel ${v}`,
            limit: 20
          }));
        }
      }

      const rankedExact = rankRows(exactRows, {
        exactArticle: articleRaw,
        preferredDoc: lawId
      });

      if (rankedExact.length > 0) {
        return res.status(200).json({
          ok: true,
          results: rankedExact.slice(0, 8)
        });
      }
    }

    // -------------------------
    // 2. PRIORITEITSWETTEN EERST
    // -------------------------
    const tokens = extractTokens(q);
    const primaryToken = tokens[0] || "";
const secondaryToken = tokens[1] || "";

    let rows = [];

    rows.push(...await queryChunks({
  docId: DOCS.awb,
  textLike: primaryToken,
  limit: 10
}));

if (secondaryToken) {
  rows.push(...await queryChunks({
    docId: DOCS.awb,
    textLike: secondaryToken,
    limit: 10
  }));
}
rows.push(...await queryChunks({
  docId: DOCS.omgevingswet,
  textLike: primaryToken,
  limit: 10
}));

if (secondaryToken) {
  rows.push(...await queryChunks({
    docId: DOCS.omgevingswet,
    textLike: secondaryToken,
    limit: 10
  }));


    // -------------------------
    // 3. ALGEMENE FALLBACK
    // -------------------------
    if (rows.length < 8) {
      rows.push(...await queryChunks({
        textLike: primaryToken,
        limit: 20
      }));
    }

    // Extra fallback met tweede token
    if (rows.length < 8 && tokens[1]) {
      rows.push(...await queryChunks({
        textLike: tokens[1],
        limit: 20
      }));
    }

    const ranked = rankRows(rows, {
      preferredDoc: detectLaw(q),
      keyword: primaryToken
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
