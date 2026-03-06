module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const test = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      },
      body: JSON.stringify({
        query_embedding: (await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: "besluit"
          })
        }).then(r => r.json())).data[0].embedding,
        match_count: 5,
        doc_filter: null
      })
    });

    const json = await test.json();

    return res.json(json);

  }

  catch(e){
    return res.json({ error: String(e) });
  }

};
