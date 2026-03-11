module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    let q = (req.query.q || "").toLowerCase().trim();

    if(!q){
      return res.json({ok:false,results:[]});
    }

    const headers = {
      apikey:SERVICE_KEY,
      Authorization:`Bearer ${SERVICE_KEY}`
    };

    // -------------------------
    // EXACT ARTIKEL LOOKUP
    // -------------------------

    const articleMatch = q.match(/artikel\s+([\d:.]+)/);

    if(articleMatch){

      const article = articleMatch[1].replace(".",":");

      const url =
        `${SUPABASE_URL}/rest/v1/chunks` +
        `?select=id,label,text,source_url` +
        `&label=ilike.*${encodeURIComponent(article)}*` +
        `&limit=5`;

      const resp = await fetch(url,{headers});
      const rows = await resp.json();

      if(Array.isArray(rows) && rows.length){
        return res.json({ok:true,results:rows});
      }

    }

    // -------------------------
    // KEYWORD SEARCH
    // -------------------------

    const keyword = q.split(" ")[0];

    const url =
      `${SUPABASE_URL}/rest/v1/chunks` +
      `?select=id,label,text,source_url` +
      `&text=ilike.*${encodeURIComponent(keyword)}*` +
      `&limit=8`;

    const resp = await fetch(url,{headers});
    const rows = await resp.json();

    return res.json({
      ok:true,
      results:Array.isArray(rows)?rows:[]
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
