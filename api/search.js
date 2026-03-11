module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    let q = (req.query.q || "").toString().trim();

    if (!q) {
      return res.json({ ok:false, results:[] });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization:`Bearer ${SERVICE_KEY}`,
      "Content-Type":"application/json"
    };

    // -------------------------
    // VECTOR SEARCH
    // -------------------------

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

    const vectorResp = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/match_chunks`,
      {
        method:"POST",
        headers,
        body: JSON.stringify({
          query_embedding: embedding,
          match_count:5,
          doc_filter:null
        })
      }
    );

    let vectorRows = [];
    if(vectorResp.ok){
      const data = await vectorResp.json();
      if(Array.isArray(data)) vectorRows = data;
    }

    // -------------------------
    // KEYWORD SEARCH
    // -------------------------

    const keyword = q.split(" ")[0];

    const keywordResp = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url` +
      `&text=ilike.*${encodeURIComponent(keyword)}*` +
      `&limit=5`,
      { headers }
    );

    let keywordRows = [];
    if(keywordResp.ok){
      const data = await keywordResp.json();
      if(Array.isArray(data)) keywordRows = data;
    }

    // -------------------------
    // COMBINE RESULTS
    // -------------------------

    const map = new Map();

    [...vectorRows, ...keywordRows].forEach(r=>{
      map.set(r.id,r);
    });

    const results = Array.from(map.values()).slice(0,8);

    return res.json({
      ok:true,
      results
    });

  }

  catch(e){

    return res.json({
      ok:false,
      error:String(e),
      results:[]
    });

  }

};
