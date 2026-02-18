// beleidsbank-api/api/search.js
// Beleidsbank PRO search — Supabase chunks ophalen + cosine similarity + HYBRID BOOST
// Response: { ok, query, results:[{id,n,label,doc_id,similarity,source_url,excerpt}] }

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

    // 1) embedding
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

    const embText = await embResp.text();
    const embJson = (() => { try { return JSON.parse(embText); } catch { return null; } })();
    if (!embResp.ok || !embJson) {
      return res.status(500).json({
        error: "OpenAI embedding failed",
        status: embResp.status,
        preview: embText.slice(0, 300),
      });
    }

    const qvec = embJson?.data?.[0]?.embedding;
    if (!Array.isArray(qvec) || qvec.length < 100) {
      return res.status(500).json({ error: "Invalid embedding from OpenAI" });
    }

    // 2) chunks ophalen (V1: nu Awb gefocust voor stabiliteit)
    // Later: uitbreiden naar alle wetten met filters (doc_id) + gemeente etc.
    const chunksUrl =
      `${SUPABASE_URL}/rest/v1/chunks` +
      `?select=id,doc_id,label,text,source_url,embedding` +
      `&doc_id=eq.BWBR0005537` +
      `&order=id.asc` +
      `&limit=5000`;

    const rowsResp = await fetch(chunksUrl, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });

    const rowsText = await rowsResp.text();
    const rows = (() => { try { return JSON.parse(rowsText); } catch { return null; } })();

    if (!rowsResp.ok || !Array.isArray(rows)) {
      return res.status(500).json({
        error: "Supabase fetch failed",
        status: rowsResp.status,
        preview: (rowsText || "").slice(0, 300),
      });
    }

    // helpers
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

    function toVec(v) {
      if (Array.isArray(v)) return v;
      if (typeof v === "string") {
        try { return JSON.parse(v); } catch { return null; }
      }
      return null;
    }

    const qLower = q.toLowerCase();

    // definitie-signal
    const wantsDefinition =
      /\bwat is\b/.test(qLower) ||
      /\bdefinitie\b/.test(qLower) ||
      /\bwordt verstaan\b/.test(qLower);

    // 3) hybrid rank
    const ranked = rows
      .map(r => {
        const emb = toVec(r.embedding);
        if (!emb) return null;

        let sim = cosine(qvec, emb);

        const txt = (r.text || "").toLowerCase();
        const label = (r.label || "").toLowerCase();

        // kleine keyword overlap
        if (qLower.includes("besluit") && txt.includes("besluit")) sim += 0.12;

        // definitie-boost
        if (wantsDefinition) {
          if (txt.includes("wordt verstaan")) sim += 0.70;
          if (txt.includes("een schriftelijke beslissing")) sim += 1.00; // Awb 1:3
        }

        // harde boost voor artikel 1:3 als het over "besluit" gaat
        if (qLower.includes("besluit") && label.includes("artikel 1:3")) sim += 2.5;

        return { ...r, similarity: sim };
      })
      .filter(Boolean)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 8);

    return res.status(200).json({
      ok: true,
      query: q,
      results: ranked.map((r, i) => ({
        id: r.id, // ✅ nodig voor /api/source + Bronnen viewer
        n: i + 1,
        label: r.label,
        doc_id: r.doc_id,
        similarity: r.similarity,
        source_url: r.source_url,
        excerpt: (r.text || "").slice(0, 1200),
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: "search crashed", details: String(e?.message || e) });
  }
};
