// beleidsbank-api/api/ingest-bwb-xml.js
// OFFICIËLE SRU ingest via overheid zoekservice (werkt server-side)

function stripTags(s){
  return (s||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}

function extractArticles(xml){

  const out=[];

  // overheid SRU XML gebruikt <artikel> maar kan namespace bevatten
  const blocks=xml.match(/<[^>]*artikel[^>]*>[\s\S]*?<\/[^>]*artikel>/gi)||[];

  for(const b of blocks){

    let nr="";

    const m=b.match(/Artikel\s+([0-9.:a-z]+)/i);
    if(m) nr=m[1].replace(".",":");

    const text=stripTags(b);

    if(text.length>80){
      out.push({nummer:nr,text});
    }
  }

  return out;
}

async function embedBatch(texts,key){

  if(!texts.length) return [];

  const r=await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${key}`
    },
    body:JSON.stringify({
      model:"text-embedding-3-small",
      input:texts.map(t=>t.slice(0,8000))
    })
  });

  const j=await r.json();
  return j.data.map(x=>x.embedding);
}

async function upsertDocument(url,key,doc){

  await fetch(`${url}/rest/v1/documents?on_conflict=id`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      apikey:key,
      Authorization:`Bearer ${key}`,
      Prefer:"resolution=merge-duplicates"
    },
    body:JSON.stringify(doc)
  });
}

async function upsertChunks(url,key,rows){

  if(!rows.length) return;

  await fetch(`${url}/rest/v1/chunks?on_conflict=doc_id,label`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      apikey:key,
      Authorization:`Bearer ${key}`,
      Prefer:"resolution=merge-duplicates"
    },
    body:JSON.stringify(rows)
  });
}

module.exports=async(req,res)=>{

  try{

    const id=(req.query.id||"").trim();

    if(!id.startsWith("BWBR")){
      return res.status(400).json({error:"use ?id=BWBR..."});
    }

    const SUPABASE_URL=process.env.SUPABASE_URL;
    const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI=process.env.OPENAI_API_KEY;

    // ✅ OFFICIËLE SRU API
    const xmlUrl=`https://zoekservice.overheid.nl/sru/Search?operation=searchRetrieve&query=bwb-id=${id}&version=1.2&recordSchema=xml`;

    const r=await fetch(xmlUrl);
    const xml=await r.text();

    if(!r.ok){
      return res.status(500).json({error:"xml fetch failed"});
    }

    const articles=extractArticles(xml);

    if(!articles.length){
      return res.status(500).json({
        error:"no articles parsed",
        debug_first_1000_chars: xml.slice(0,1000)
      });
    }

    await upsertDocument(
      SUPABASE_URL,
      KEY,
      {id,title:id,source_url:xmlUrl}
    );

    const texts=articles.map(a=>a.text);
    const embeds=await embedBatch(texts,OPENAI);

    const rows=articles.map((a,i)=>({
      doc_id:id,
      label:`${id} — Artikel ${a.nummer}`,
      text:a.text,
      source_url:xmlUrl,
      embedding:embeds[i]
    }));

    await upsertChunks(SUPABASE_URL,KEY,rows);

    return res.json({
      ok:true,
      id,
      articles:rows.length
    });

  }catch(e){

    return res.status(500).json({
      error:"xml ingest crashed",
      details:String(e.message||e)
    });

  }
};
