module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error:"missing q" });

    // embedding maken
    const emb = await fetch("https://api.openai.com/v1/embeddings", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:`Bearer ${OPENAI_KEY}`
      },
      body:JSON.stringify({
        model:"text-embedding-3-small",
        input:q
      })
    }).then(r=>r.json());

    const vec = emb.data[0].embedding;

    // haal chunks op (laat db sorteren doen we later)
    const rows = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding`,
      {
        headers:{
          apikey:SERVICE_KEY,
          Authorization:`Bearer ${SERVICE_KEY}`
        }
      }
    ).then(r=>r.json());

    // similarity lokaal berekenen (V1-proof en werkt altijd)
    function cosine(a,b){
      let dot=0,na=0,nb=0;
      for(let i=0;i<a.length;i++){
        dot+=a[i]*b[i];
        na+=a[i]*a[i];
        nb+=b[i]*b[i];
      }
      return dot/(Math.sqrt(na)*Math.sqrt(nb));
    }

    const ranked = rows.map(r=>({
      ...r,
      similarity: cosine(vec, r.embedding)
    }))
    .sort((a,b)=>b.similarity-a.similarity)
    .slice(0,5);

    res.json({
      ok:true,
      query:q,
      results:ranked.map((r,i)=>({
        n:i+1,
        doc_id:r.doc_id,
        label:r.label,
        similarity:r.similarity,
        source_url:r.source_url,
        excerpt:r.text.slice(0,800)
      }))
    });

  } catch(e){
    res.status(500).json({ crash:String(e) });
  }
};
