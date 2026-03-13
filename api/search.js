module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY || !OPENAI_KEY) {
      return res.status(500).json({ ok:false, error:"Missing env", results:[] });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type":"application/json"
    };

    const q = (req.query.q || "").toString().trim().toLowerCase();

    if (!q) {
      return res.status(200).json({ ok:true, results:[] });
    }

    function clean(text){
      return (text || "")
        .replace(/\s+/g," ")
        .replace(/Toon relaties in LiDO/gi,"")
        .replace(/Maak een permanente link/gi,"")
        .replace(/Toon wetstechnische informatie/gi,"")
        .replace(/Druk het regelingonderdeel af/gi,"")
        .replace(/Sla het regelingonderdeel op/gi,"")
        .trim();
    }

    function dedupe(rows){
      const map = new Map();

      for(const r of rows || []){
        if(!r) continue;

        const key = `${r.doc_id}|${(r.label||"").toLowerCase()}`;

        if(!map.has(key)){
          map.set(key,r);
        }
      }

      return Array.from(map.values());
    }

    // --------------------------------------------------
    // 1 EXACT ARTICLE LOOKUP
    // --------------------------------------------------

    const articleMatch = q.match(/artikel\s+([0-9:.]+)/);

    if(articleMatch){

      const article = articleMatch[1];

      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&label=ilike.*${article}*&limit=10`,
        { headers }
      );

      const json = await resp.json();

      if(Array.isArray(json) && json.length){

        const results = json.map(r=>({
          id:r.id,
          label:r.label,
          text:clean(r.text),
          excerpt:clean(r.text),
          source_url:r.source_url,
          doc_id:r.doc_id
        }));

        return res.status(200).json({ ok:true, results });
      }
    }

    // --------------------------------------------------
    // 2 EMBEDDING
    // --------------------------------------------------

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

    // --------------------------------------------------
    // 3 VECTOR SEARCH
    // --------------------------------------------------

    let vectorResults = [];

    if(embedding){

      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/match_chunks`,
        {
          method:"POST",
          headers,
          body: JSON.stringify({
            query_embedding: embedding,
            match_count:20
          })
        }
      );

      const json = await resp.json();

      if(Array.isArray(json)){
        vectorResults = json;
      }

    }

    // --------------------------------------------------
    // 4 KEYWORD SEARCH
    // --------------------------------------------------

    const keywordResp = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&text=ilike.*${encodeURIComponent(q)}*&limit=20`,
      { headers }
    );

    const keywordResults = await keywordResp.json();

    // --------------------------------------------------
    // 5 COMBINE
    // --------------------------------------------------

    const combined = dedupe([
      ...vectorResults,
      ...(Array.isArray(keywordResults) ? keywordResults : [])
    ]);

    // --------------------------------------------------
    // 6 BASIC RELEVANCE SORT
    // --------------------------------------------------

    const ranked = combined
      .map(r=>{

        let score = 0;

        const text = (r.text||"").toLowerCase();
        const label = (r.label||"").toLowerCase();

        if(text.includes("wordt verstaan")) score += 3;
        if(text.includes("schriftelijke beslissing")) score += 5;

        if(label.includes("artikel 1")) score += 2;

        return { ...r, score };

      })
      .sort((a,b)=>b.score - a.score);

    const results = ranked.slice(0,15).map(r=>({

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
