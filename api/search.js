module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY || !OPENAI_KEY) {
      return res.status(500).json({
        ok:false,
        error:"Missing env variables",
        results:[]
      });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type":"application/json"
    };

    const q = (req.query.q || "").toString().trim();

    if(!q){
      return res.status(200).json({
        ok:true,
        results:[]
      });
    }

    function clean(text){
      return (text||"")
        .replace(/\s+/g," ")
        .replace(/Toon relaties in LiDO/gi,"")
        .replace(/Maak een permanente link/gi,"")
        .replace(/Toon wetstechnische informatie/gi,"")
        .replace(/Druk het regelingonderdeel af/gi,"")
        .replace(/Sla het regelingonderdeel op/gi,"")
        .trim();
    }

    function dedupe(rows){
      const map=new Map();

      for(const r of rows||[]){
        if(!r) continue;

        const key=`${r.doc_id}|${(r.label||"").toLowerCase()}`;

        if(!map.has(key)){
          map.set(key,r);
        }
      }

      return Array.from(map.values());
    }

    // -----------------------------
    // 1 EMBEDDING
    // -----------------------------

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

    const embedding = embedJson?.data?.[0]?.embedding;

    if(!embedding){
      throw new Error("Embedding failed");
    }

    // -----------------------------
    // 2 VECTOR SEARCH
    // -----------------------------

    let vectorResults=[];

    try{

      const vectorResp = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/match_chunks`,
        {
          method:"POST",
          headers,
          body: JSON.stringify({
            query_embedding: embedding,
            match_count:15
          })
        }
      );

      const json = await vectorResp.json();

      if(Array.isArray(json)){
        vectorResults=json;
      }

    }catch(e){
      console.log("vector search failed",e);
    }

    // -----------------------------
    // 3 KEYWORD SEARCH (fallback)
    // -----------------------------

    let keywordResults=[];

    try{

      const keywordResp = await fetch(
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&text=ilike.*${encodeURIComponent(q)}*&limit=15`,
        { headers }
      );

      const json = await keywordResp.json();

      if(Array.isArray(json)){
        keywordResults=json;
      }

    }catch(e){
      console.log("keyword search failed",e);
    }

    // -----------------------------
    // 4 COMBINE
    // -----------------------------

    const combined = dedupe([
      ...vectorResults,
      ...keywordResults
    ]);

    const results = combined.slice(0,15).map(r=>({
      id:r.id,
      label:r.label,
      text:clean(r.text),
      excerpt:clean(r.text),
      source_url:r.source_url,
      doc_id:r.doc_id
    }));

    return res.status(200).json({
      ok:true,
      results
    });

  }

  catch(e){

    return res.status(500).json({
      ok:false,
      error:String(e?.message||e),
      results:[]
    });

  }
};
