// /api/chat.js — Beleidsbank V1.2 (Domain-first retrieval)

const sessionStore = new Map();
const rateStore = new Map();
const cacheStore = new Map();

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const MAX_SOURCES_RETURN = 8;
const MAX_EXCERPTS = 6;
const MIN_EXCERPTS = 3;

const CORE_BOUW_SOURCES = [
  "Omgevingswet",
  "Besluit bouwwerken leefomgeving",
  "Besluit activiteiten leefomgeving",
  "Omgevingsbesluit"
];

function nowMs(){ return Date.now(); }
function normalize(s){ return (s||"").toLowerCase().trim(); }

// ---------- basic ----------

function makeFetchWithTimeout(){
  return async (url, options={}, ms=15000)=>{
    const c = new AbortController();
    const id = setTimeout(()=>c.abort(), ms);
    try{ return await fetch(url,{...options,signal:c.signal}); }
    finally{ clearTimeout(id); }
  };
}

function rateLimit(ip, limit=20, windowMs=60000){
  const now = nowMs();
  const v = rateStore.get(ip)||{count:0,resetAt:now+windowMs};
  if(now>v.resetAt){ v.count=0; v.resetAt=now+windowMs; }
  v.count++;
  rateStore.set(ip,v);
  return v.count<=limit;
}

function pickAll(text,re){
  return [...text.matchAll(re)].map(m=>m[1]);
}

function dedupeByLink(arr){
  const seen=new Set();
  return (arr||[]).filter(x=>{
    if(!x?.link || seen.has(x.link)) return false;
    seen.add(x.link);
    return true;
  });
}

// ---------- OpenAI ----------

async function callOpenAI({apiKey,fetchWithTimeout,messages,max_tokens=700}){
  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${apiKey}`
      },
      body:JSON.stringify({
        model:"gpt-4o-mini",
        temperature:0.2,
        max_tokens,
        messages
      })
    },
    20000
  );

  const raw = await r.text();
  if(!r.ok) return {ok:false,raw};

  try{
    const d = JSON.parse(raw);
    return {ok:true,content:d.choices?.[0]?.message?.content||""};
  }catch{
    return {ok:false,raw};
  }
}

function safeJson(s){ try{return JSON.parse(s);}catch{return null;} }

function ensureFormat(t){
  const lc=(t||"").toLowerCase();
  if(lc.includes("antwoord:") && lc.includes("toelichting:")) return t;
  return `Antwoord:\n${t}\n\nToelichting:\n-`;
}

// ---------- DOMAIN PLANNER (KEY IMPROVEMENT) ----------

async function planner({apiKey,fetchWithTimeout,lastUser,pending}){

  const system = `
Je bent Beleidsbank planner.

Doel:
1) Bepaal juridisch domein.
2) Beslis of extra info echt nodig is.
3) Geef ALLEEN JSON.

Regels:
- Antwoord eerst als dat redelijk kan.
- Vraag alleen door bij echte blockers.
- Geen overbodige vragen.

Domeinen:
- bouw
- evenement
- apv
- milieu
- belasting
- algemeen

Schema:
{
 "domain":"bouw|evenement|apv|milieu|belasting|algemeen",
 "needs_followup": boolean,
 "followup_questions": string[],
 "answer_mode":"direct|general_then_ask|ask_only",
 "municipality": string|null,
 "historical_mode": boolean,
 "allow_wabo": boolean,
 "query_terms": string[]
}
`.trim();

  const user = JSON.stringify({question:lastUser,pending});

  const r = await callOpenAI({
    apiKey,fetchWithTimeout,max_tokens:350,
    messages:[
      {role:"system",content:system},
      {role:"user",content:user}
    ]
  });

  if(!r.ok) return null;
  return safeJson(r.content);
}

// ---------- SRU SEARCH ----------

async function bwbSearchByTitles({titles,fetchWithTimeout}){
  const cql = titles
    .map(t=>`overheidbwb.titel any "${t}"`)
    .join(" OR ");

  const url =
    `https://zoekservice.overheid.nl/sru/Search` +
    `?version=1.2&operation=searchRetrieve&x-connection=BWB` +
    `&maximumRecords=25&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
  const titlesFound = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

  return dedupeByLink(ids.map((id,i)=>({
    id,
    title: titlesFound[i] || id,
    link:`https://wetten.overheid.nl/${id}`,
    type:"BWB"
  })));
}

async function cvdrSearch({municipality,topic,fetchWithTimeout}){
  if(!municipality) return [];

  const cql =
    `(dcterms.creator="Gemeente ${municipality}") AND (keyword all "${topic}")`;

  const url =
    `https://zoekdienst.overheid.nl/sru/Search` +
    `?version=1.2&operation=searchRetrieve&x-connection=cvdr` +
    `&maximumRecords=25&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(CVDR[0-9_]+)<\/dcterms:identifier>/g);
  const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

  return dedupeByLink(ids.map((id,i)=>({
    id,
    title: titles[i]||id,
    link:`https://lokaleregelgeving.overheid.nl/${id}`,
    type:"CVDR"
  })));
}

// ---------- EXCERPTS ----------

function htmlToTextLite(html){
  return (html||"")
    .replace(/<script[\s\S]*?<\/script>/gi,"")
    .replace(/<style[\s\S]*?<\/style>/gi,"")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
}

// ---------- ANSWERER ----------

async function answerer({apiKey,fetchWithTimeout,question,plan,excerpts}){

  const system = `
Je bent Beleidsbank.

Regels:
- Beantwoord eerst praktisch.
- Juridisch correct.
- Geen bronnen tonen.
- Geen model-meta tekst.
- Alleen:

Antwoord:
Toelichting:
`.trim();

  const user = JSON.stringify({question,plan,excerpts});

  return await callOpenAI({
    apiKey,fetchWithTimeout,max_tokens:850,
    messages:[
      {role:"system",content:system},
      {role:"user",content:user}
    ]
  });
}

// ---------- MAIN ----------

export default async function handler(req,res){

  const origin=(req.headers.origin||"").toString();
  res.setHeader("Access-Control-Allow-Origin",
    origin===ALLOW_ORIGIN?origin:ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const ip=req.headers["x-forwarded-for"]?.split(",")[0]||"unknown";
  if(!rateLimit(ip)) return res.status(429).json({error:"Too many requests"});

  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey) return res.status(500).json({error:"Missing API key"});

  const body=req.body||{};
  const sessionId=body.session_id||"stateless";

  const msg = body.message ||
    body.messages?.at(-1)?.content;

  if(!msg) return res.status(400).json({error:"Missing message"});

  const fetchWithTimeout=makeFetchWithTimeout();

  const sess = sessionStore.get(sessionId)||{pending:null};

  // PLAN
  const plan = await planner({
    apiKey,
    fetchWithTimeout,
    lastUser: msg,
    pending: sess.pending
  });

  if(!plan){
    return res.status(200).json({
      answer:"Antwoord:\nIk kon de vraag niet analyseren.\n\nToelichting:\n- Probeer opnieuw.",
      sources:[]
    });
  }

  // -------- DOMAIN SOURCE ROUTING --------
  let sources=[];

  if(plan.domain==="bouw"){
    sources.push(...await bwbSearchByTitles({
      titles: CORE_BOUW_SOURCES,
      fetchWithTimeout
    }));
  } else {
    // fallback generic
    sources.push(...await bwbSearchByTitles({
      titles:["Omgevingswet"],
      fetchWithTimeout
    }));
  }

  // gemeentelijk indien bekend
  if(plan.municipality){
    sources.push(...await cvdrSearch({
      municipality: plan.municipality,
      topic: plan.query_terms.join(" "),
      fetchWithTimeout
    }));
  }

  sources = dedupeByLink(sources);

  // excerpts
  const read = sources.slice(0,
    Math.min(MAX_EXCERPTS, Math.max(MIN_EXCERPTS,sources.length))
  );

  const excerpts = [];
  for(const s of read){
    const html = await (await fetchWithTimeout(s.link)).text();
    excerpts.push({
      source:s,
      excerpt: htmlToTextLite(html).slice(0,3000)
    });
  }

  // ANSWER
  const ans = await answerer({
    apiKey,
    fetchWithTimeout,
    question:msg,
    plan,
    excerpts
  });

  const answer = ensureFormat(ans.ok?ans.content:"Er ging iets mis.");

  sessionStore.set(sessionId,{
    pending: plan.needs_followup
      ? {questions:plan.followup_questions}
      : null
  });

  return res.status(200).json({
    answer,
    sources: sources.slice(0,MAX_SOURCES_RETURN)
  });
}
