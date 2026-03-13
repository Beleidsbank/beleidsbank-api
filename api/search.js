module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json"
    };

    const q = (req.query.q || "").toString().trim();

    if (!q) {
      return res.status(200).json({ ok:true, results:[] });
    }

    function cleanText(text){
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

        const key = `${r.doc_id}|${(r.label || "").toLowerCase()}`;

        if(!map.has(key)){
          map.set(key,r);
        }
      }

      return Array.from(map.values());
    }

    // -------------------------
    // 1 embedding
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

    // -------------------------
    // 2 vector search
    // -------------------------

    const vectorResp = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/match_chunks`,
      {
        method:"POST",
        headers,
        body: JSON.stringify({
          query_embedding: embedding,
          match_count: 20
        })
      }
    );

    const vectorResults = await vectorResp.json();

    // -------------------------
    // 3 keyword search
    // -------------------------

    const keywordResp = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&text=ilike.*${encodeURIComponent(q)}*&limit=20`,
      { headers }
    );

    const keywordResults = await keywordResp.json();

    // -------------------------
    // 4 combine
    // -------------------------

    const combined = dedupe([
      ...(vectorResults || []),
      ...(keywordResults || [])
    ]);

    if (!combined.length) {
      return res.status(200).json({ ok:true, results:[] });
    }

    // -------------------------
    // 5 AI rerank
    // -------------------------

    const passages = combined.slice(0,20).map((r,i)=>{

      const txt = cleanText(r.text).slice(0,400);

      return `[${i+1}] ${txt}`;

    }).join("\n\n");

    const rerankResp = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          Authorization:`Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model:"gpt-4o-mini",
          temperature:0,
          max_tokens:200,
          messages:[
            {
              role:"system",
              content:
`Selecteer de 8 passages die het meest relevant zijn voor de vraag.
Geef alleen de nummers terug als lijst.
Voorbeeld: 1,4,7`
            },
            {
              role:"user",
              content:
`Vraag: ${q}

Passages:
${passages}`
            }
          ]
        })
      }
    );

    const rerankJson = await rerankResp.json();

    const order =
      rerankJson?.choices?.[0]?.message?.content
      ?.match(/\d+/g)
      ?.map(n=>parseInt(n)-1)
      || [];

    const ranked = order
      .map(i=>combined[i])
      .filter(Boolean);

    const results = ranked.map(r=>({
      id:r.id,
      label:r.label,
      text:cleanText(r.text),
      excerpt:cleanText(r.text),
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
      error:String(e?.message || e),
      results:[]
    });

  }
};
