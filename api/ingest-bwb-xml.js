// beleidsbank-api/api/ingest-bwb-xml.js
// STABIELE productie ingest voor wetten.overheid.nl
// GEEN dependencies nodig
// GET /api/ingest-bwb-xml?id=BWBR0037885

function cleanHtml(html){
  return (html||"")
    // scripts/styles eruit
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    // UI teksten verwijderen
    .replace(/Toon relaties in LiDO/gi," ")
    .replace(/Maak een permanente link/gi," ")
    .replace(/Toon wetstechnische informatie/gi," ")
    .replace(/Druk het regelingonderdeel af/gi," ")
    .replace(/Sla het regelingonderdeel op/gi," ")
    // tags strippen
    .replace(/<[^>]+>/g," ")
    // whitespace fix
    .replace(/\s+/g," ")
    .trim();
}

// split op "Artikel X"
function splitArticles(text){

  const re=/Artikel\s+[0-9]+(?:[.:][0-9a-z]+)*/gi;

  const matches=[...text.matchAll(re)];

  if(!matches.length) return [];

  const blocks=[];

  for(let i=0;i<matches.length;i++){

    const start=matches[i].index;
    const end=(i+1<matches.length)?matches[i+1].index:text.length;

    const chunk=text.slice(start,end).trim();

   // alleen echte artikelen: moet een lidnummer bevatten ("1 ")
if(chunk.length>120 && /\b1\s/.test(chunk)){
  blocks.push(chunk);
}
  }

  return blocks;
}

function getArticleNumber(block){

  const m=block.match(/Artikel\s+([0-9]+(?:[.:][0-9a-z]+)*)/i);

  if(!m) return "";

  return m[1].replace(".",":");
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

  if(!r.ok) throw new Error("OpenAI "+JSON.stringify(j));

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

    if(!/^BWBR/.test(id)){
      return res.status(400).json({error:"use ?id=BWBR..."});
    }

    const SUPABASE_URL=process.env.SUPABASE_URL;
    const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI=process.env.OPENAI_API_KEY;

    const url=`https://wetten.overheid.nl/${id}`;

    const r=await fetch(url,{redirect:"follow"});
    const html=await r.text();

    if(!r.ok){
      return res.status(500).json({error:"fetch failed"});
    }

    const clean=cleanHtml(html);

    const blocks=splitArticles(clean);

    if(!blocks.length){
      return res.status(500).json({
        error:"no articles parsed",
        preview:clean.slice(0,500)
      });
    }

    await upsertDocument(
      SUPABASE_URL,
      KEY,
      {id,title:id,source_url:url}
    );

    const embeds=await embedBatch(blocks,OPENAI);

    // dedupe op artikelnummer
    const seen=new Set();
    const rows=[];

    blocks.forEach((b,i)=>{

      const nr=getArticleNumber(b);
      const label=`${id} — Artikel ${nr}`;

      if(seen.has(label)) return;
      seen.add(label);

      rows.push({
        doc_id:id,
        label,
        text:b,
        source_url:url,
        embedding:embeds[i]
      });
    });

    await upsertChunks(SUPABASE_URL,KEY,rows);

    return res.json({
      ok:true,
      id,
      articles:rows.length
    });

  }catch(e){

    return res.status(500).json({
      error:"ingest crashed",
      details:String(e.message||e)
    });

  }
};
