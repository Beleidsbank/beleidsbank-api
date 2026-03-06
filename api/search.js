module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ ok:false, error:"missing query" });

    // embedding maken
    const embResp = await fetch("https://api.openai.com/v1/embeddings",{
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
    const embedding = embJson?.data?.[0]?.embedding;

    if(!embedding) {
      return res.json({ ok:false, error:"embedding failed"});
    }

    // directe vector query (GEEN RPC)
    const query = `
      select id,label,text,source_url,
      1 - (embedding <=> '[${embedding.join(",")}]') as similarity
      from chunks
      order by embedding <=> '[${embedding.join(",")}]'
      limit 5
    `;

    const dbResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/query`,{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        apikey:SERVICE_KEY,
        Authorization:`Bearer ${SERVICE_KEY}`
      },
      body:JSON.stringify({ query })
    });

   const data = await dbResp.json();

const rows = Array.isArray(data) ? data : (data?.data || []);

const results = rows.map(r => ({
  id: r.id,
  label: r.label,
  text: r.text,
  excerpt: r.text,
  source_url: r.source_url
}));
      id:r.id,
      label:r.label,
      text:r.text,
      excerpt:r.text,
      source_url:r.source_url
    }));

    return res.json({
      ok:true,
      results
    });

  }

  catch(e){
    return res.json({
      ok:false,
      error:String(e)
    });
  }
};
