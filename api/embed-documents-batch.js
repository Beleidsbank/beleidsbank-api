module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    // Pak max 200 documenten zonder embedding
    const docsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/documents?select=id,title&embedding=is.null&limit=200`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`
        }
      }
    );

    const docs = await docsResp.json();
    if (!docs.length) {
      return res.json({ done: true });
    }

    for (const doc of docs) {
      const embResp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: doc.title
        })
      });

      const embJson = await embResp.json();
      const embedding = embJson?.data?.[0]?.embedding;

      await fetch(`${SUPABASE_URL}/rest/v1/documents?id=eq.${doc.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`
        },
        body: JSON.stringify({ embedding })
      });
    }

    return res.json({ processed: docs.length });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
