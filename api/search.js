module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const q = (req.query.q || "").toString().trim();

    if (!q) {
      return res.status(400).json({ ok:false, error:"missing query"});
    }

    // 1️⃣ embedding maken
    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:`Bearer ${OPENAI_KEY}`
      },
      body:JSON.stringify({
        model:"text-embedding-3-small",
        input:q
      })
    });

    const embJson = await embResp.json();
    const embedding = embJson.data?.[0]?.embedding;

    if(!embedding){
      return res.status(500).json({ ok:false, error:"embedding failed"});
    }

    // 2️⃣ vector search via pgvector RPC
    const supaResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_chunks`,{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        apikey:SERVICE_KEY,
        Authorization:`Bearer ${SERVICE_KEY}`
      },
      body:JSON.stringify({
        query_embedding:embedding,
        match_count:8,
        doc_filter:null
      })
    });

    const supaJson = await supaResp.json();

    if(!supaResp.ok){
      return res.status(500).json({ ok:false, error:"vector search failed", details:supaJson});
    }

    // 3️⃣ normaliseren
    const results = (supaJson || []).map(r => ({
      id: r.id,
      label: r.label,
      text: r.text,
      excerpt: r.text,
      source_url: r.source_url
    }));

    return res.json({
      ok:true,
      results
    });

  }

  catch(e){
    return res.status(500).json({
      ok:false,
      error:String(e)
    });
  }

};
