module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY || !OPENAI_KEY) {
      return res.status(500).json({ ok:false,error:"Missing env"});
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    };

    const q = (req.query.q || "").toString().trim();

    if (!q) {
      return res.json({ ok:true, results:[] });
    }

    const qLower = q.toLowerCase();

    // ---------------------------------
    // 1 ARTIKEL LOOKUP
    // ---------------------------------

    const articleMatch = qLower.match(/artikel\s+([0-9:.]+)/);

    if (articleMatch){

      const article = articleMatch[1];

      const variants = new Set([
        article,
        article.replace(/\./g,":"),
        article.replace(/:/g,".")
      ]);

      let rows=[];

      for (const v of variants){

        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&label=ilike.*${encodeURIComponent(v)}*&limit=10`,
          { headers }
        );

        const json = await r.json();

        if (Array.isArray(json)) rows.push(...json);

      }

      if (rows.length){

        return res.json({
          ok:true,
          results: rows.slice(0,10)
        });

      }

    }

    // ---------------------------------
    // 2 EMBEDDING
    // ---------------------------------

    const embedResp = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          Authorization:`Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model:"text-embedding-3-small",
          input:q
        })
      }
    );

    const embedJson = await embedResp.json();

    const embedding = embedJson.data[0].embedding;

    // ---------------------------------
    // 3 HYBRID SEARCH
    // ---------------------------------

    const searchResp = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/hybrid_search`,
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          apikey:SERVICE_KEY,
          Authorization:`Bearer ${SERVICE_KEY}`
        },
        body: JSON.stringify({
          query_embedding: embedding,
          query_text: qLower,
          match_count: 15
        })
      }
    );

    const results = await searchResp.json();

    if (!Array.isArray(results)) {
      return res.json({ ok:true, results:[] });
    }

    return res.json({
      ok:true,
      results: results.map(r=>({
        id:r.id,
        label:r.label,
        text:r.text,
        excerpt:r.text,
        source_url:r.source_url,
        doc_id:r.doc_id
      }))
    });

  }

  catch(e){

    return res.status(500).json({
      ok:false,
      error:String(e)
    });

  }

};
