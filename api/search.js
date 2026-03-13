module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(200).json({
        ok: true,
        results: []
      });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    };

    const q = (req.query.q || "").toString().trim().toLowerCase();

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

    // --------------------------------
    // 1 ARTIKEL DETECTIE
    // --------------------------------

    const articleMatch = q.match(/artikel\s+([0-9:.]+)/i);

    if (articleMatch) {

      const article = articleMatch[1];

      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&label=ilike.*${article}*&limit=20`,
        { headers }
      );

      const rows = await resp.json();

      if (!Array.isArray(rows) || !rows.length) {
        return res.status(200).json({ ok: true, results: [] });
      }

      const uniqueDocs =
        [...new Set(rows.map(r => r.doc_id).filter(Boolean))];

      // meerdere wetten → ambiguous
      if (uniqueDocs.length > 1) {

        return res.status(200).json({
          ok: true,
          ambiguous: true,
          question: "Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
          options: rows.slice(0, 5).map(r => ({
            title: r.label,
            doc_id: r.doc_id
          })),
          results: []
        });

      }

      const results = rows.slice(0, 5).map(r => ({
        id: r.id,
        label: r.label,
        text: clean(r.text),
        excerpt: clean(r.text),
        source_url: r.source_url,
        doc_id: r.doc_id
      }));

      return res.status(200).json({
        ok: true,
        results
      });

    }

    // --------------------------------
    // 2 EMBEDDING
    // --------------------------------

    let embedding = null;

    try {

      const embedResp = await fetch(
        "https://api.openai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_KEY}`
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: q
          })
        }
      );

      const embedJson = await embedResp.json();

      embedding = embedJson?.data?.[0]?.embedding;

    } catch {}

    // --------------------------------
    // 3 VECTOR SEARCH
    // --------------------------------

    let vectorResults = [];

    if (embedding) {

      try {

        const vectorResp = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/match_chunks`,
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              query_embedding: embedding,
              match_count: 15
            })
          }
        );

        const json = await vectorResp.json();

        if (Array.isArray(json)) {
          vectorResults = json;
        }

      } catch {}

    }

    // --------------------------------
    // 4 KEYWORD SEARCH
    // --------------------------------

    let keywordResults = [];

    try {

      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&text=ilike.*${encodeURIComponent(q)}*&limit=15`,
        { headers }
      );

      const json = await resp.json();

      if (Array.isArray(json)) {
        keywordResults = json;
      }

    } catch {}

    // --------------------------------
    // 5 COMBINE
    // --------------------------------

    const combined = [
      ...vectorResults,
      ...keywordResults
    ];

    const results = combined.slice(0, 15).map(r => ({
      id: r.id,
      label: r.label,
      text: clean(r.text),
      excerpt: clean(r.text),
      source_url: r.source_url,
      doc_id: r.doc_id
    }));

    return res.status(200).json({
      ok: true,
      results
    });

  }

  catch (e) {

    return res.status(200).json({
      ok: true,
      results: []
    });

  }
};
