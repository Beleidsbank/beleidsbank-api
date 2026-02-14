// /api/chat.js — Beleidsbank V1 (relevant sources only, general, stable)

const BWB = "https://zoekservice.overheid.nl/sru/Search";
const CVDR = "https://zoekdienst.overheid.nl/sru/Search";

const MAX_FETCH = 18;
const MAX_FINAL = 6;

// zware ruis in lokale regelgeving → omlaag tenzij excerpt match
const TITLE_DEMOTE = [
  "aanwijzingsbesluit",
  "intrekking",
  "preventief",
  "fouilleren",
  "mandaat",
  "overgang",
  "wijziging",
  "invoerings",
];

// ---------------- helpers ----------------

function normalize(s){
  return (s||"").toLowerCase().replace(/\s+/g," ").trim();
}

function extractTerms(q){
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu," ")
    .split(" ")
    .filter(w=>w.length>3)
    .slice(0,10);
}

function municipality(q){
  const m=q.match(/\b(?:in|te|bij)\s+([A-Z][A-Za-z]+)/);
  return m?.[1]||null;
}

async function sru(endpoint,conn,cql){
  const r=await fetch(
    `${endpoint}?version=1.2&operation=searchRetrieve&x-connection=${conn}&x-info-1-accept=any&maximumRecords=50&query=${encodeURIComponent(cql)}`
  );
  return r.text();
}

function parse(xml,type){
  const recs=xml.match(/<record[\s\S]*?<\/record>/g)||[];
  return recs.map(r=>{
    const id=r.match(/<dcterms:identifier>([^<]+)/)?.[1];
    const title=r.match(/<dcterms:title>([\s\S]*?)<\/dcterms:title>/)?.[1]?.replace(/<[^>]+>/g,"").trim();
    if(!id||!title) return null;
    if(type==="BWB"&&!/^BWBR/.test(id)) return null;
    if(type==="CVDR"&&!/^CVDR/.test(id)) return null;
    return {
      id,
      title,
      link:type==="BWB"
        ?`https://wetten.overheid.nl/${id}`
        :`https://lokaleregelgeving.overheid.nl/${id}`,
      type
    };
  }).filter(Boolean);
}

// groter stuk tekst lezen → juiste paragraaf vaker gevonden
async function excerpt(url,terms){
  try{
    const r=await fetch(url);
    const html=await r.text();

    const txt=html
      .replace(/<script[\s\S]*?<\/script>/gi,"")
      .replace(/<style[\s\S]*?<\/style>/gi,"")
      .replace(/<[^>]+>/g,"\n")
      .replace(/\n+/g,"\n");

    const lines=txt.split("\n");

    const hits=[];
    for(let i=0;i<lines.length;i++){
      const l=normalize(lines[i]);
      if(terms.some(t=>l.includes(t))){
        hits.push(lines.slice(i-10,i+10).join("\n"));
        if(hits.length>=4) break;
      }
    }

    return hits.join("\n").slice(0,3000);
  }catch{
    return "";
  }
}

// ---------------- handler ----------------

export default async function handler(req,res){

  const q=req.body?.message||"";
  if(!q) return res.status(400).json({error:"missing message"});

  const terms=extractTerms(q);
  const mun=municipality(q);

  // ---------- zoek wetten ----------
  const bwbXML=await sru(
    BWB,
    "BWB",
    terms.map(t=>`overheidbwb.titel any "${t}"`).join(" OR ")
  );

  let sources=parse(bwbXML,"BWB");

  // ---------- zoek gemeentelijke regels ----------
  if(mun){
    const cvdrXML=await sru(
      CVDR,
      "cvdr",
      `(dcterms.creator="${mun}" OR dcterms.creator="Gemeente ${mun}")`
    );
    sources=[...parse(cvdrXML,"CVDR"),...sources];
  }

  // ---------- demote obvious noise ----------
  sources=sources
    .map(s=>{
      let score=0;
      const t=normalize(s.title);

      if(s.type==="CVDR") score+=5;

      if(t.includes("verordening")) score+=8;
      if(t.includes("apv")) score+=10;

      for(const w of TITLE_DEMOTE){
        if(t.includes(w)) score-=15;
      }

      return {...s,score};
    })
    .sort((a,b)=>b.score-a.score)
    .slice(0,MAX_FETCH);

  // ---------- read excerpts ----------
  const withText=[];
  for(const s of sources){
    const ex=await excerpt(s.link,terms);
    if(ex.length>100) withText.push({...s,excerpt:ex});
  }

  // ---------- keep only relevant ----------
  const relevant=withText
    .map(s=>{
      const hit=terms.filter(t=>normalize(s.excerpt).includes(t)).length;
      return {...s,hit};
    })
    .filter(s=>s.hit>0)
    .sort((a,b)=>b.hit-a.hit)
    .slice(0,MAX_FINAL);

  if(!relevant.length){
    return res.json({
      answer:"Geen bruikbare passages gevonden in officiële bronnen.",
      sources:[]
    });
  }

  // ---------- ask AI ----------
  const api=process.env.OPENAI_API_KEY;

  const payload={
    question:q,
    sources:relevant.map((s,i)=>({
      n:i+1,
      title:s.title,
      excerpt:s.excerpt.slice(0,2500)
    }))
  };

  const ai=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${api}`
    },
    body:JSON.stringify({
      model:"gpt-4o-mini",
      temperature:0.2,
      messages:[
        {
          role:"system",
          content:`
Je bent Beleidsbank.

Beantwoord ALLEEN op basis van bronnen.

Regels:
- citeer met [1],[2]
- gebruik alleen gegeven bronnen
- geen placeholders
`
        },
        {role:"user",content:JSON.stringify(payload)}
      ]
    })
  });

  const json=await ai.json();
  const answer=json.choices?.[0]?.message?.content||"Geen antwoord.";

  return res.json({
    answer,
    sources:relevant.map(s=>({
      title:s.title,
      link:s.link,
      type:s.type
    }))
  });
}
