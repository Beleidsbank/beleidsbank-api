module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    let q = (req.query.q || "").toString().toLowerCase();

    if (!q) {
      return res.json({ ok:false, results:[] });
    }

    // simpele vraagwoorden verwijderen
    q = q
      .replace("wat is", "")
      .replace("wat betekent", "")
      .replace("wat houdt", "")
      .replace("leg uit", "")
      .replace("definitie", "")
      .replace("?", "")
      .trim();

    // splits in woorden
    const words = q.split(" ").filter(w => w.length > 2);

    if(words.length === 0){
      return res.json({ ok:false, results:[] });
    }

    const keyword = words[0];

// definities eerst uit Awb halen
const awbUrl =
  `${SUPABASE_URL}/rest/v1/chunks` +
  `?select=id,label,text,source_url` +
  `&doc_id=eq.BWBR0005537` +
  `&text=ilike.*${encodeURIComponent(keyword)}*` +
  `&limit=5`;

const respAwb = await fetch(awbUrl,{
  headers:{
    apikey:SERVICE_KEY,
    Authorization:`Bearer ${SERVICE_KEY}`
  }
});

let rows = await respAwb.json();

if(!rows || rows.length === 0){

  const url =
    `${SUPABASE_URL}/rest/v1/chunks` +
    `?select=id,label,text,source_url` +
    `&text=ilike.*${encodeURIComponent(keyword)}*` +
    `&limit=8`;

  const resp = await fetch(url,{
    headers:{
      apikey:SERVICE_KEY,
      Authorization:`Bearer ${SERVICE_KEY}`
    }
  });

  rows = await resp.json();
}
    const rows = await resp.json();

    const results = (rows || []).map(r => ({
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
