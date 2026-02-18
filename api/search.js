// /api/search.js
// Beleidsbank PRO search — Supabase chunks ophalen + cosine similarity + HYBRID BOOST (definitie/keyword/artikel)
// Response: { ok, query, results:[{n,doc_id,label,similarity,source_url,excerpt}] }

module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" });
    if (!OPENAI_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "missing q" });

    // --- 1) embedding maken ---
    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: q,
      }),
    });

    const embJson = await embResp.json();
    if (!embResp.ok) return res.status(500).json({ error: "OpenAI embedding failed", details: embJson });

    const vec = embJson?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length < 10) {
      return res.status(500).json({ error: "Invalid embedding from OpenAI" });
    }

    // --- 2) haal chunks op uit Supabase ---
    // V1: simpel alles (limit) ophalen. Later optimaliseren naar db-side vector search + filters.
    const rowsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding&limit=2000`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      }
    );

    const rows = await rowsResp.json();
    if (!rowsResp.ok) {
      return res.status(500).json({ error: "Supabase fetch failed", details: rows });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(200).json({ ok: true, query: q, results: [] });
    }

    // --- helpers ---
    function cosine(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    function toVector(v) {
      if (Array.isArray(v)) return v;
      if (typeof v === "string") {
        try { return JSON.parse(v); } catch { return null; }
      }
      return null;
    }

    // --- 3) hybrid rerank ---
    const qLower = q.toLowerCase();

    // signalen voor definitievragen
    const wantsDefinition =
      /\bwat is\b/.test(qLower) ||
      /\bdefinitie\b/.test(qLower) ||
      /\bwordt verstaan\b/.test(qLower);

    const ranked = rows
      .map((r) => {
        const emb = toVector(r.embedding);
        if (!emb) return null;

        let sim = cosine(vec, emb);

        const txt = (r.text || "").toLowerCase();
        const label = (r.label || "").toLowerCase();

        // basic keyword overlap boost (zwak)
        // let op: "besluit" komt heel vaak voor, dus kleine boost
        if (qLower.includes("besluit") && txt.includes("besluit")) sim += 0.12;

        // Definitie-boost: trekt definities/begripsartikelen omhoog
        if (wantsDefinition) {
          if (txt.includes("wordt verstaan")) sim += 0.55;
          if (txt.includes("onder") && txt.includes("wordt verstaan")) sim += 0.25;
          // typische Awb 1:3 frase
          if (txt.includes("een schriftelijke beslissing")) sim += 0.80;
        }

        // HARD boost voor artikel 1:3 wanneer vraag over "besluit"
        if (qLower.includes("besluit") && label.includes("artikel 1:3")) sim += 2.0;

        return { ...r, similarity: sim };
      })
      .filter(Boolean)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 8);

    return res.status(200).json({
      ok: true,
      query: q,
      results: ranked.map((r, i) => ({
        n: i + 1,
        doc_id: r.doc_id,
        label: r.label,
        similarity: r.similarity,
        source_url: r.source_url,
        excerpt: (r.text || "").slice(0, 1200),
      })),
    });
  } catch (e) {
    return res.status(500).json({ crash: String(e?.message || e) });
  }
};
