// beleidsbank-api/api/ingest-bwb-xml.js
// Production XML ingest voor wetten.overheid.nl
// GET /api/ingest-bwb-xml?id=BWBR0037885

const { XMLParser } = require("fast-xml-parser");

function safeJsonParse(s){ try{return JSON.parse(s);}catch{return null;} }

async function embedBatch(texts, apiKey){
  if (!texts.length) return [];

  const r = await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model:"text-embedding-3-small",
      input:texts.map(t=>t.slice(0,8000))
    })
  });

  const t = await r.text();
  const j = safeJsonParse(t);

  if(!r.ok) throw new Error("OpenAI failed: "+t.slice(0,200));
  return j.data.map(x=>x.embedding);
}

function collectArticles(node, out=[]){

  if(!node || typeof node!=="object") return out;

  if(node.Artikel){

    const arr = Array.isArray(node.Artikel)
      ? node.Artikel
      : [node.Artikel];

    for(const a of arr){

      let nummer = "";

      if(a.Kop?.Nummer){
        nummer = String(a.Kop.Nummer).trim();
      }

      let text = JSON.stringify(a);

      out.push({ nummer, text });
    }
  }

  for(const k in node){
    collectArticles(node[k], out);
  }

  return out;
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

module.exports = async (req,res)=>{

  try{

    const id = (req.query.id||"").trim();
    if(!id.startsWith("BWBR")){
      return res.status(400).json({error:"use ?id=BWBR..."});
    }

    const SUPABASE_URL=process.env.SUPABASE_URL;
    const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI=process.env.OPENAI_API_KEY;

    // officiële XML bron
    const xmlUrl=`https://wetten.overheid.nl/${id}/tekst.xml`;

    const r=await fetch(xmlUrl);
    const xml=await r.text();

    if(!r.ok){
      return res.status(500).json({error:"xml fetch failed"});
    }

    const parser=new XMLParser({
      ignoreAttributes:false
    });

    const j=parser.parse(xml);

    const arts=collectArticles(j);

    if(!arts.length){
      return res.status(500).json({error:"no articles parsed"});
    }

    await upsertDocument(
      SUPABASE_URL,
      KEY,
      {id,title:id,source_url:xmlUrl}
    );

    const texts=arts.map(a=>a.text);

    const embeds=await embedBatch(texts,OPENAI);

    const rows=arts.map((a,i)=>({
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
