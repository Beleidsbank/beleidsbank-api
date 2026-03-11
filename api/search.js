module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    let q = (req.query.q || "").toString().toLowerCase().trim();

    if (!q) {
      return res.json({ ok:false, results:[] });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization:`Bearer ${SERVICE_KEY}`
    };

    // -------------------------------
    // EXACT ARTIKEL LOOKUP
    // -------------------------------

    const articleMatch = q.match(/artikel\s+([\d:.]+)/i);

    if(articleMatch){

      const article = articleMatch[1];

      const url =
        `${SUPABASE_URL}/rest/v1/chunks` +
        `?select=id,label,text,source_url` +
        `&label=ilike.*${encodeURIComponent(article)}*` +
        `&limit=5`;

      const resp = await fetch(url,{ headers });

      const rows = await resp.json();

      if(Array.isArray(rows) && rows.length > 0){
        return res.json({
          ok:true,
          results:rows
        });
      }

    }

    // -------------------------------
    // NORMALE KEYWORD SEARCH
    // -------------------------------

    q = q
      .replace("wat is","")
      .replace("wat betekent","")
      .replace("wat houdt","")
      .replace("leg uit","")
      .replace("?","")
      .trim();

    const keyword = q.split(" ")[0];

    const url =
      `${SUPABASE_URL}/rest/v1/chunks` +
      `?select=id,label,text,source_url` +
      `&text=ilike.*${encodeURIComponent(keyword)}*` +
      `&limit=8`;

    const resp = await fetch(url,{ headers });

    const rows = await resp.json();

    return res.json({
      ok:true,
      results:Array.isArray(rows) ? rows : []
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
