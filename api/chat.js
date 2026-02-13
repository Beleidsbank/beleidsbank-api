// /api/chat.js — Beleidsbank V1 (clean, general, AI-assisted, all municipalities)
//
// Input:
// {
//   session_id: "abc123",                 // REQUIRED for memory; new chat must generate new id
//   messages: [{ role:"user|assistant", content:"..." }],  // chat history for this session (frontend)
//   // (optional legacy) message: "..."     // if you still send single message
// }
//
// Output:
// {
//   answer: "Antwoord:\n...\n\nToelichting:\n...",
//   sources: [{ title, link, type, id }]
// }

const rateStore = new Map();     // ip -> {count, resetAt}
const sessionStore = new Map();  // sessionId -> { history:[{role,content}], pending:{slotsNeeded:[], collected:{}}, updatedAt }
const cacheStore = new Map();    // key -> { value, expiresAt }

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

// SRU endpoints
const SRU_CVDR = "https://zoekdienst.overheid.nl/sru/Search";     // x-connection=cvdr
const SRU_BWB  = "https://zoekservice.overheid.nl/sru/Search";    // x-connection=BWB

// Limits
const MAX_HISTORY_TURNS = 10;              // for session memory
const MAX_SOURCES_RETURN = 8;              // UI sources returned
const MIN_EXCERPTS_FETCH = 3;              // adaptively read at least this many if possible
const MAX_EXCERPTS_FETCH = 8;              // cap heavy fetches
const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000; // 2h

function nowMs() { return Date.now(); }

function cleanupStores() {
  const now = nowMs();

  // expire sessions after 30 minutes of inactivity (tweak)
  for (const [sid, v] of sessionStore.entries()) {
    const updatedAt = Number(v?.updatedAt || 0);
    if (!updatedAt || (now - updatedAt) > 30 * 60 * 1000) sessionStore.delete(sid);
  }

  // rateStore cleanup
  for (const [ip, v] of rateStore.entries()) {
    const resetAt = Number(v?.resetAt || 0);
    if (!resetAt || now > (resetAt + 2 * 60 * 1000)) rateStore.delete(ip);
  }

  // cacheStore cleanup
  for (const [k, v] of cacheStore.entries()) {
    const expiresAt = Number(v?.expiresAt || 0);
    if (!expiresAt || now > expiresAt) cacheStore.delete(k);
  }
}

function cacheGet(key) {
  const it = cacheStore.get(key);
  if (!it) return null;
  if (nowMs() > it.expiresAt) { cacheStore.delete(key); return null; }
  return it.value;
}
function cacheSet(key, value, ttlMs) {
  cacheStore.set(key, { value, expiresAt: nowMs() + ttlMs });
}

function rateLimit(ip, limit = 20, windowMs = 60000) {
  const now = nowMs();
  const item = rateStore.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > item.resetAt) { item.count = 0; item.resetAt = now + windowMs; }
  item.count++;
  rateStore.set(ip, item);
  return item.count <= limit;
}

function makeFetchWithTimeout() {
  return async (url, options = {}, ms = 15000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally { clearTimeout(id); }
  };
}

function normalize(s) { return (s || "").toLowerCase().trim(); }

function dedupeByLink(items) {
  const seen = new Set();
  const out = [];
  for (const x of items || []) {
    if (!x?.link) continue;
    if (seen.has(x.link)) continue;
    seen.add(x.link);
    out.push(x);
  }
  return out;
}

function pickAll(text, re) {
  return [...text.matchAll(re)].map(m => m[1]);
}

function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|br|tr|td)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickRelevantLines(text, keywords, maxLines = 24) {
  const lines = (text || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const keys = (keywords || []).map(k => normalize(k)).filter(Boolean);
  if (!keys.length) return lines.slice(0, Math.min(maxLines, lines.length)).join("\n");

  const hits = [];
  for (const l of lines) {
    const lc = normalize(l);
    if (keys.some(k => lc.includes(k))) hits.push(l);
    if (hits.length >= maxLines) break;
  }
  return (hits.length ? hits : lines).slice(0, Math.min(maxLines, (hits.length ? hits : lines).length)).join("\n");
}

async function fetchExcerptForSource({ source, keywords, fetchWithTimeout }) {
  const cacheKey = `ex:${source.id}:${(keywords || []).join("|").slice(0, 160)}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  try {
    const resp = await fetchWithTimeout(source.link, {}, 15000);
    const html = await resp.text();
    const text = htmlToTextLite(html);
    const excerpt = pickRelevantLines(text, keywords, 24);
    const out = excerpt ? excerpt.slice(0, 3600) : null;
    cacheSet(cacheKey, out, EXCERPT_TTL_MS);
    return out;
  } catch {
    cacheSet(cacheKey, null, 15 * 60 * 1000);
    return null;
  }
}

// ---------------------------
// SRU: CVDR (lokale regelgeving) + BWB (landelijke wetgeving)
// ---------------------------
async function cvdrSearch({ municipalityName, topicText, fetchWithTimeout, max = 25 }) {
  const creatorsToTry = [
    municipalityName,
    `Gemeente ${municipalityName}`,
    `gemeente ${municipalityName}`,
  ].filter(Boolean);

  const safeTopic = (topicText || "").replaceAll('"', "").trim() || "";
  if (!municipalityName || !safeTopic) return [];

  for (const creator of creatorsToTry) {
    const cql = `(dcterms.creator="${creator}") AND (keyword all "${safeTopic}")`;
    const url =
      `${SRU_CVDR}?version=1.2&operation=searchRetrieve&x-connection=cvdr&x-info-1-accept=any` +
      `&maximumRecords=${max}&startRecord=1&query=${encodeURIComponent(cql)}`;

    const resp = await fetchWithTimeout(url, {}, 15000);
    const xml = await resp.text();

    const ids = pickAll(xml, /<dcterms:identifier>(CVDR[0-9_]+)<\/dcterms:identifier>/g);
    const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

    const items = ids.map((id, i) => ({
      id,
      title: titles[i] || id,
      link: `https://lokaleregelgeving.overheid.nl/${id}`,
      type: "CVDR"
    }));

    const uniq = dedupeByLink(items);
    if (uniq.length) return uniq;
  }
  return [];
}

async function bwbSruSearch({ cql, fetchWithTimeout, max = 25 }) {
  const url =
    `${SRU_BWB}?version=1.2&operation=searchRetrieve&x-connection=BWB` +
    `&maximumRecords=${max}&startRecord=1&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url, {}, 15000);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
  const titlesA = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);
  const titlesB = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);
  const titles = titlesA.length ? titlesA : titlesB;

  const items = ids.map((id, i) => ({
    id,
    title: titles[i] || id,
    link: `https://wetten.overheid.nl/${id}`,
    type: "BWB"
  }));

  return dedupeByLink(items);
}

// ---------------------------
// OpenAI calls
// ---------------------------
async function callOpenAI({ apiKey, fetchWithTimeout, model, messages, temperature = 0.2, max_tokens = 800 }) {
  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature, max_tokens, messages })
    },
    20000
  );
  const raw = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, raw };
  try {
    const data = JSON.parse(raw);
    const content = (data?.choices?.[0]?.message?.content || "").trim();
    return { ok: true, content };
  } catch (e) {
    return { ok: false, status: 500, raw: `JSON parse failed: ${String(e)}\nRAW:\n${raw}` };
  }
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function ensureTwoHeadings(text) {
  const t = (text || "").trim();
  const lc = t.toLowerCase();
  if (lc.includes("antwoord:") && lc.includes("toelichting:")) return t;
  return ["Antwoord:", t || "Ik kan hier nog geen goed antwoord op geven.", "", "Toelichting:", "- Kun je iets meer context geven?"].join("\n");
}

// 1) Planner: JSON-only, general, no city hardcode
async function planner({ apiKey, fetchWithTimeout, history, pending }) {
  const system = `
Je bent Beleidsbank: een conversational assistent voor Nederlandse wet- en regelgeving en beleid (landelijk + gemeentelijk).
Gedrag:
- Als de vraag duidelijk is: geef direct antwoord.
- Als de vraag te vaag is: stel 1–3 gerichte vragen.
- Als de vraag gemeentelijk kan zijn maar gemeente ontbreekt: geef een algemeen antwoord + vraag daarna om de gemeente.
- Noem geen bronnen in de tekst; frontend toont sources[].

Geef ALLEEN JSON, geen extra tekst. Schema:
{
  "needs_followup": boolean,
  "followup_questions": string[],
  "slots_needed": string[],               // bv ["municipality","timeframe","location_detail"]
  "slots_collected": { "municipality"?: string, "timeframe"?: string },
  "search_plan": {
    "use_bwb": boolean,
    "use_cvdr": boolean,
    "municipality": string|null,
    "query_terms": string[],              // keywords voor SRU + excerpt select
    "bwb_cql": string|null,               // optioneel
    "cvdr_topic": string|null
  },
  "answer_mode": "direct" | "general_then_ask" | "ask_only",
  "historical_mode": boolean,
  "allow_wabo": boolean
}
Regels:
- Wabo niet standaard; alleen allow_wabo=true als user Wabo noemt of als historical_mode=true (oud recht / datum vóór 2024).
`.trim();

  const user = `
HISTORY (laatste turns):
${JSON.stringify(history.slice(-MAX_HISTORY_TURNS), null, 2)}

PENDING (kan null zijn):
${JSON.stringify(pending || null, null, 2)}
`.trim();

  const r = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 450,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  if (!r.ok) return { ok: false, error: r.raw };
  const plan = safeJsonParse(r.content);
  if (!plan) return { ok: false, error: `Planner JSON ongeldig: ${r.content}` };
  return { ok: true, plan };
}

// 2) Answerer: uses excerpts, two headings only
async function answerer({ apiKey, fetchWithTimeout, history, plan, sourcesPack }) {
  const system = `
Je beantwoordt vragen over Nederlandse wet- en regelgeving en beleid.

Belangrijk:
- Noem ALLEEN artikel-/lidverwijzingen als die letterlijk in de aangeleverde uittreksels staan.
- Als uittreksels geen expliciete norm tonen: geef een praktisch antwoord, maar formuleer voorzichtig en zeg welke info ontbreekt.
- Antwoord conversatie-achtig en helder (zoals ChatGPT), niet stijf.

Output (ALLEEN):
Antwoord:
Toelichting:
`.trim();

  const user = `
PLAN:
${JSON.stringify(plan, null, 2)}

BRONNEN + UITTREKSELS:
${sourcesPack}

HISTORY:
${JSON.stringify(history.slice(-MAX_HISTORY_TURNS), null, 2)}
`.trim();

  return await callOpenAI({
    apiKey,
    fetchWithTimeout,
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 900,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
}

// Build a default CQL from terms if planner didn't provide one
function buildDefaultBwbCql(terms) {
  const safe = (terms || []).map(t => String(t).replaceAll('"', "").trim()).filter(Boolean).slice(0, 7);
  if (!safe.length) return `overheidbwb.titel any "Omgevingswet"`;
  return safe.map(t => `overheidbwb.titel any "${t}"`).join(" OR ");
}

// ---------------------------
// MAIN handler
// ---------------------------
export default async function handler(req, res) {
  cleanupStores();

  // CORS
  const origin = (req.headers.origin || "").toString();
  res.setHeader("Access-Control-Allow-Origin", origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt." });

  const body = req.body || {};
  const sessionId = (body.session_id || "").toString().trim();
  if (!sessionId) {
    // Important: to avoid memory leaks across "new chat", require session_id for stateful chat
    // If you want stateless operation, you can allow it, but then no pending/history.
    // Here we allow stateless but keep it clean.
  }

  // Incoming messages
  let incoming = body.messages;
  if (!Array.isArray(incoming) || !incoming.length) {
    const msg = (body.message || "").toString().trim();
    if (!msg) return res.status(400).json({ error: "Missing messages/message" });
    incoming = [{ role: "user", content: msg }];
  }

  // Load session state (strict per sessionId)
  const session = sessionId ? (sessionStore.get(sessionId) || { history: [], pending: null, updatedAt: nowMs() }) : null;
  const history = session ? [...session.history] : [];

  // Append incoming to history (keep last turns)
  for (const m of incoming) {
    if (!m?.role || !m?.content) continue;
    history.push({ role: m.role, content: String(m.content) });
  }
  const trimmedHistory = history.slice(-MAX_HISTORY_TURNS);

  const fetchWithTimeout = makeFetchWithTimeout();

  // Plan
  const p = await planner({
    apiKey,
    fetchWithTimeout,
    history: trimmedHistory,
    pending: session?.pending || null
  });

  if (!p.ok) {
    const fallback = ensureTwoHeadings([
      "Antwoord:",
      "Ik kon je vraag net niet goed analyseren.",
      "",
      "Toelichting:",
      "- Kun je je vraag net iets concreter maken?"
    ].join("\n"));
    return res.status(200).json({ answer: fallback, sources: [] });
  }

  const plan = p.plan;

  // Update pending + store session
  if (sessionId) {
    const collected = { ...(session.pending?.collected || {}), ...(plan.slots_collected || {}) };
    const slotsNeeded = Array.isArray(plan.slots_needed) ? plan.slots_needed : [];

    const pending =
      plan.needs_followup && slotsNeeded.length
        ? { slotsNeeded, collected }
        : null;

    sessionStore.set(sessionId, {
      history: trimmedHistory,
      pending,
      updatedAt: nowMs()
    });
  }

  // If planner says ask-only, we can respond without searching
  if (plan.answer_mode === "ask_only") {
    const msg = ensureTwoHeadings([
      "Antwoord:",
      "Ik kan je helpen, maar ik mis nog een detail om dit precies te beantwoorden.",
      "",
      "Toelichting:",
      ...(Array.isArray(plan.followup_questions) && plan.followup_questions.length
        ? plan.followup_questions.map(q => `- ${q}`)
        : ["- Kun je iets meer context geven?"])
    ].join("\n"));
    return res.status(200).json({ answer: msg, sources: [] });
  }

  // Search plan
  const sp = plan.search_plan || {};
  const useBwb = !!sp.use_bwb;
  const useCvdr = !!sp.use_cvdr;

  const municipality =
    sp.municipality ||
    plan?.slots_collected?.municipality ||
    session?.pending?.collected?.municipality ||
    null;

  const queryTerms = Array.isArray(sp.query_terms) ? sp.query_terms.filter(Boolean) : [];
  const keywords = queryTerms.length ? queryTerms.slice(0, 12) : [];

  // Search sources
  let sources = [];

  if (useBwb) {
    const cql = sp.bwb_cql || buildDefaultBwbCql(queryTerms);
    const bwb = await bwbSruSearch({ cql, fetchWithTimeout, max: 25 });

    // Wabo: not banned. Filter only if planner says not allowed.
    const allowWabo = !!plan.allow_wabo;
    const filtered = allowWabo ? bwb : bwb.filter(x => String(x.id || "").toUpperCase() !== "BWBR0024779");

    sources.push(...filtered);
  }

  if (useCvdr) {
    // Only possible when municipality known. If not known, we still can answer generally.
    if (municipality) {
      const topic = sp.cvdr_topic || queryTerms.join(" ") || trimmedHistory.at(-1)?.content || "";
      const cvdr = await cvdrSearch({ municipalityName: municipality, topicText: topic, fetchWithTimeout, max: 25 });
      sources.push(...cvdr);
    }
  }

  sources = dedupeByLink(sources);

  // Pick how many to read (adapt)
  const toRead = sources.slice(0, Math.min(MAX_EXCERPTS_FETCH, Math.max(MIN_EXCERPTS_FETCH, sources.length)));
  const excerpts = [];
  for (const s of toRead) {
    const ex = await fetchExcerptForSource({ source: s, keywords, fetchWithTimeout });
    excerpts.push({ source: s, excerpt: ex });
  }

  const sourcesPack = excerpts.map((x, i) => {
    const s = x.source;
    const head = `Bron ${i + 1}: ${s.title}\nType: ${s.type}\nID: ${s.id}\nLink: ${s.link}`;
    const ex = x.excerpt ? `\n\nUittreksel:\n${x.excerpt}` : "\n\nUittreksel:\n(niet opgehaald)";
    return `${head}${ex}`;
  }).join("\n\n---\n\n");

  // Answer with evidence
  const a = await answerer({
    apiKey,
    fetchWithTimeout,
    history: trimmedHistory,
    plan,
    sourcesPack
  });

  if (!a.ok) {
    const fallback = ensureTwoHeadings([
      "Antwoord:",
      "Ik kon nu geen volledig antwoord genereren door een tijdelijke fout.",
      "",
      "Toelichting:",
      "- Probeer het opnieuw of geef iets meer context (bijv. gemeente, periode, locatie)."
    ].join("\n"));
    return res.status(200).json({ answer: fallback, sources: sources.slice(0, MAX_SOURCES_RETURN) });
  }

  const answer = ensureTwoHeadings(a.content);

  // UI sources: return a bit broader than read set (still capped)
  const uiSources = sources.slice(0, MAX_SOURCES_RETURN);

  return res.status(200).json({ answer, sources: uiSources });
}
