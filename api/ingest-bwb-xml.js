// beleidsbank-api/api/ingest-bwb-xml.js
// XML ingest ZONDER dependencies (werkt direct op Vercel)

function safeJsonParse(s){ try{return JSON.parse(s);}catch{return null;} }

function stripTags(s){
  return (s||"")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
}

function extractArticles(xml){

  const out=[];

  // pak alles tussen <artikel ...> en </artikel>
  const blocks=xml.match(/<artikel[\s\S]*?<\/artikel>/gi)||[];

  for(const b of blocks){

    // nummer uit <label>Artikel 5.1</label>
    let nr="";

    const m=b.match(/<label[^>]*>(.*?)<\/label>/i);
    if(m){
      const t=m[1]
        .replace(/<[^>]+>/g," ")
        .replace(/\s+/g," ")
        .trim();

      // pak alleen het nummer uit "Artikel 5.1"
      const n=t.match(/([0-9]+(?:\.[0-9a-z]+)?)/i);
      if(n) nr=n[1].replace(".",":");
    }

    const text=b
      .replace(/<[^>]+>/g," ")
      .replace(/\s+/g," ")
      .trim();

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

  const t=await r.text();
  const j=safeJsonParse(t);

  if(!r.ok) throw new Error("OpenAI "+t.slice(0,200));

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

    const xmlUrl=`https://wetten.overheid.nl/${id}/tekst.xml`;

    const r=await fetch(xmlUrl);
    const xml=await r.text();

    if(!r.ok){
      return res.status(500).json({error:"xml fetch failed"});
    }

    const articles=extractArticles(xml);

    if(!articles.length){
      return res.status(500).json({error:"no articles parsed"});
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
