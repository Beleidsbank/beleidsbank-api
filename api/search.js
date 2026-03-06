module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    let q = (req.query.q || "").toString().toLowerCase();

    if (!q) {
      return res.json({ ok:false, results:[] });
    }

    // vraagwoorden verwijderen
    q = q
      .replace("wat is","")
      .replace("wat betekent","")
      .replace("wat houdt","")
      .replace("leg uit","")
      .replace("?","")
      .trim();

    const keyword = q.split(" ")[0];

    const headers = {
      apikey: SERVICE_KEY,
      Authorization:`Bearer ${SERVICE_KEY}`
    };

    let rows = [];

    // eerst Awb
    const awbUrl =
      `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url` +
      `&doc_id=eq.BWBR0005537` +
      `&text=ilike.*${encodeURIComponent(keyword)}*` +
      `&limit=5`;

    const awbResp = await fetch(awbUrl,{ headers });

    if(awbResp.ok){
      const data = await awbResp.json();
      if(Array.isArray(data)) rows = data;
    }

    // fallback: alle wetten
    if(rows.length === 0){

      const url =
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url` +
        `&text=ilike.*${encodeURIComponent(keyword)}*` +
        `&limit=8`;

      const resp = await fetch(url,{ headers });

      if(resp.ok){
        const data = await resp.json();
        if(Array.isArray(data)) rows = data;
      }

    }

    const results = rows.map(r => ({
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
      error:String(e),
      results:[]
    });

  }

};
