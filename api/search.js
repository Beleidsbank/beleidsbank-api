// beleidsbank-api/api/search.js

module.exports = async (req, res) => {

  // -------------------------
  // CORS (HEEL BELANGRIJK)
  // -------------------------
  res.setHeader("Access-Control-Allow-Origin", "https://app.beleidsbank.nl");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" });
    if (!OPENAI_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "missing q" });

    // -------------------------
    // 1. embedding maken
    // -------------------------
    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: q
      })
    });

    const embJson = await embResp.json();

    if (!embResp.ok) {
      return res.status(500).json({
        error: "Embedding failed",
        details: embJson
      });
    }

    const qvec = embJson.data[0].embedding;

    // -------------------------
    // 2. chunks ophalen uit Supabase
    // -------------------------
    const rowsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding&limit=5000`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`
        }
      }
    );

    const rows = await rowsResp.json();

    if (!rowsResp.ok) {
      return res.status(500).json({
        error: "Supabase fetch failed",
        details: rows
      });
    }

    // -------------------------
    // cosine similarity
    // -------------------------
    function cosine(a,b){
      let dot=0, na=0, nb=0;
      for(let i=0;i<a.length;i++){
        dot+=a[i]*b[i];
        na+=a[i]*a[i];
        nb+=b[i]*b[i];
      }
      return dot/(Math.sqrt(na)*Math.sqrt(nb));
    }

    function toVec(v){
      if(Array.isArray(v)) return v;
      if(typeof v==="string"){
        try { return JSON.parse(v); } catch { return null; }
      }
      return null;
    }

    const qLower = q.toLowerCase();

    // -------------------------
    // 3. ranking
    // -------------------------
    const ranked = rows
      .map(r=>{
        const emb = toVec(r.embedding);
        if(!emb) return null;

        let sim = cosine(qvec, emb);

        const txt = (r.text||"").toLowerCase();
        const label = (r.label||"").toLowerCase();

        // kleine keyword boost
        if(qLower.includes("besluit") && txt.includes("besluit")) sim += 0.12;

        // definitie boost
        if(qLower.includes("wat is")){
          if(txt.includes("wordt verstaan")) sim += 0.7;
        }

        // harde boost artikel 1:3
        if(qLower.includes("besluit") && label.includes("1:3")) sim += 2.5;

        return {...r, similarity: sim};
      })
      .filter(Boolean)
      .sort((a,b)=>b.similarity-a.similarity)
      .slice(0,8);

    // -------------------------
    // 4. response
    // -------------------------
    return res.status(200).json({
      ok:true,
      query:q,
      results: ranked.map((r,i)=>({
        id: r.id,
        n: i+1,
        label: r.label,
        doc_id: r.doc_id,
        similarity: r.similarity,
        source_url: r.source_url,
        excerpt: (r.text||"").slice(0,1200)
      }))
    });

  } catch(e){

    return res.status(500).json({
      error:"search crashed",
      details:String(e?.message||e)
    });

  }
};
