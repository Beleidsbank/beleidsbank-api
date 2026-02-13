// Beleidsbank V1 — Conversational + Evidence-based
// Response:
// { answer: "...", sources:[{title,link,type,id}] }

const rateStore = new Map();
const sessionStore = new Map();
const cacheStore = new Map();

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const MAX_HISTORY = 8;
const MAX_SOURCES_RETURN = 8;
const MIN_EXCERPTS = 3;
const MAX_EXCERPTS = 8;

const WABO_ID = "BWBR0024779";

// ---------- helpers ----------

function nowMs() { return Date.now(); }

function normalize(s) {
  return (s || "").toLowerCase().trim();
}

function dedupeByLink(items) {
  const seen = new Set();
  return (items || []).filter(i => {
    if (!i?.link || seen.has(i.link)) return false;
    seen.add(i.link);
    return true;
  });
}

function cacheGet(key) {
  const v = cacheStore.get(key);
  if (!v) return null;
  if (nowMs() > v.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  return v.value;
}

function cacheSet(key, value, ttl) {
  cacheStore.set(key, { value, expiresAt: nowMs() + ttl });
}

function makeFetchWithTimeout() {
  return async (url, options = {}, ms = 15000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };
}

function rateLimit(ip, limit = 20, windowMs = 60000) {
  const now = nowMs();
  const item = rateStore.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + windowMs;
  }
  item.count++;
  rateStore.set(ip, item);
  return item.count <= limit;
}

function pickAll(text, re) {
  return [...text.matchAll(re)].map(m => m[1]);
}

// ---------- HTML → text ----------

function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickRelevantLines(text, keywords, max = 22) {
  const lines = text.split("\n").map(x => x.trim()).filter(Boolean);
  if (!keywords?.length) return lines.slice(0, max).join("\n");

  const hits = lines.filter(l =>
    keywords.some(k => normalize(l).includes(normalize(k)))
  );

  return (hits.length ? hits : lines).slice(0, max).join("\n");
}

// ---------- OpenAI ----------

async function callOpenAI({ apiKey, fetchWithTimeout, messages, max_tokens = 700 }) {
  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens,
        messages
      })
    },
    20000
  );

  const raw = await resp.text();
  if (!resp.ok) return { ok:false, raw };

  try {
    const data = JSON.parse(raw);
    return { ok:true, content:data.choices?.[0]?.message?.content || "" };
  } catch {
    return { ok:false, raw };
  }
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function ensureTwoHeadings(t) {
  const lc = (t || "").toLowerCase();
  if (lc.includes("antwoord:") && lc.includes("toelichting:")) return t;
  return `Antwoord:\n${t}\n\nToelichting:\n-`;
}

// ---------- Planner (AI controls flow) ----------

async function planner({ apiKey, fetchWithTimeout, history, pending }) {
  const system = `
Je bent Beleidsbank, een gesprekspartner voor Nederlandse wetgeving en beleid.

BELANGRIJK:
- Antwoord DIRECT als dat kan.
- Stel alleen vervolgvragen als antwoord anders onmogelijk is.
- Vraag NIET iets dat de gebruiker juist vraagt.
- Als gemeente ontbreekt: geef algemeen antwoord + vraag daarna om gemeente.

Geef ALLEEN JSON:

{
 "needs_followup": boolean,
 "followup_questions": string[],
 "answer_mode": "direct" | "general_then_ask" | "ask_only",
 "slots_collected": { "municipality"?: string },
 "search_plan": {
   "use_bwb": boolean,
   "use_cvdr": boolean,
   "municipality": string|null,
   "query_terms": string[]
 },
 "historical_mode": boolean,
 "allow_wabo": boolean
}
`.trim();

  const user = JSON.stringify({ history, pending });

  const r = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    messages:[
      { role:"system", content:system },
      { role:"user", content:user }
    ],
    max_tokens:450
  });

  if (!r.ok) return null;
  return safeJsonParse(r.content);
}

// ---------- SRU searches ----------

async function bwbSearch({ terms, fetchWithTimeout }) {
  const cql =
    terms.length
      ? terms.slice(0,6).map(t => `overheidbwb.titel any "${t}"`).join(" OR ")
      : `overheidbwb.titel any "Omgevingswet"`;

  const url =
    `https://zoekservice.overheid.nl/sru/Search` +
    `?version=1.2&operation=searchRetrieve&x-connection=BWB` +
    `&maximumRecords=25&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
  const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

  return dedupeByLink(ids.map((id,i)=>({
    id,
    title: titles[i] || id,
    link:`https://wetten.overheid.nl/${id}`,
    type:"BWB"
  })));
}

async function cvdrSearch({ municipality, topic, fetchWithTimeout }) {
  if (!municipality) return [];

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
    title: titles[i] || id,
    link:`https://lokaleregelgeving.overheid.nl/${id}`,
    type:"CVDR"
  })));
}

// ---------- answerer ----------

async function answerer({ apiKey, fetchWithTimeout, history, excerpts }) {
  const system = `
Geef een helder antwoord zoals ChatGPT.

Regels:
- Noem artikelnummers alleen als letterlijk zichtbaar in excerpts.
- Geen bronlijst tonen (frontend doet dat).
Output exact:

Antwoord:
Toelichting:
`.trim();

  const user = JSON.stringify({ history, excerpts });

  return await callOpenAI({
    apiKey,
    fetchWithTimeout,
    messages:[
      { role:"system", content:system },
      { role:"user", content:user }
    ],
    max_tokens:850
  });
}

// ---------- main ----------

export default async function handler(req,res){

  const origin = (req.headers.origin||"").toString();
  res.setHeader("Access-Control-Allow-Origin", origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  if (!rateLimit(ip)) return res.status(429).json({ error:"Too many requests" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error:"Missing API key" });

  const body = req.body || {};
  const sessionId = body.session_id || "stateless";

  let messages = body.messages;
  if (!messages?.length) {
    messages = [{ role:"user", content: body.message }];
  }

  const session = sessionStore.get(sessionId) || { history:[], pending:null };
  const history = [...session.history, ...messages].slice(-MAX_HISTORY);

  const fetchWithTimeout = makeFetchWithTimeout();

  // PLAN
  const plan = await planner({
    apiKey,
    fetchWithTimeout,
    history,
    pending: session.pending
  });

  if (!plan) {
    return res.status(200).json({
      answer:"Antwoord:\nIk kon je vraag niet analyseren.\n\nToelichting:\n- Probeer opnieuw.",
      sources:[]
    });
  }

  // SEARCH
  let sources = [];
  const terms = plan.search_plan?.query_terms || [];

  if (plan.search_plan?.use_bwb)
    sources.push(...await bwbSearch({ terms, fetchWithTimeout }));

  if (plan.search_plan?.use_cvdr)
    sources.push(...await cvdrSearch({
      municipality: plan.search_plan.municipality,
      topic: terms.join(" "),
      fetchWithTimeout
    }));

  sources = dedupeByLink(sources);

  // excerpts
  const readSources = sources.slice(0,
    Math.min(MAX_EXCERPTS, Math.max(MIN_EXCERPTS, sources.length))
  );

  const excerpts = [];
  for (const s of readSources) {
    const cached = cacheGet(s.id);
    if (cached) { excerpts.push(cached); continue; }

    const html = await (await fetchWithTimeout(s.link)).text();
    const text = htmlToTextLite(html);
    const ex = pickRelevantLines(text, terms);

    const item = { source:s, excerpt:ex };
    excerpts.push(item);
    cacheSet(s.id, item, 2*60*60*1000);
  }

  // ANSWER
  const ans = await answerer({
    apiKey,
    fetchWithTimeout,
    history,
    excerpts
  });

  const answerText = ensureTwoHeadings(ans.ok ? ans.content : "Er ging iets mis.");

  // save session
  sessionStore.set(sessionId, {
    history,
    pending: plan.needs_followup ? {
      questions: plan.followup_questions || []
    } : null
  });

  return res.status(200).json({
    answer: answerText,
    sources: sources.slice(0, MAX_SOURCES_RETURN)
  });
}
