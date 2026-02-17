// /api/search.js
module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "missing q" });

    // embedding van vraag
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

    const query_embedding = JSON.stringify(embJson.data[0].embedding);

    // call Supabase RPC
    const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
  query_embedding: query_embedding,
  match_count: 5
}),

    });

    const dataText = await rpcResp.text();
    if (rpcResp.status >= 300) {
      return res.status(500).json({ error: "Supabase RPC failed", status: rpcResp.status, details: dataText });
    }

    const data = JSON.parse(dataText);

    return res.status(200).json({
      ok: true,
      query: q,
      results: data.map((r, i) => ({
        n: i + 1,
        doc_id: r.doc_id,
        label: r.label,
        source_url: r.source_url,
        similarity: r.similarity,
        excerpt: (r.text || "").slice(0, 800),
      })),
    });

  } catch (e) {
    return res.status(500).json({ crash: String(e?.message || e) });
  }
};
