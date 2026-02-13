// /api/chat.js — Beleidsbank V1 (vereenvoudigd, AI-gestuurd, conversational)

const rateStore = new Map();
const pendingStore = new Map(); // sessionId -> { missing:[], collected:{}, messages:[...], createdAt }

const cacheStore = new Map();   // key -> { value, expiresAt }

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";
const DEFAULT_MAX_SOURCES_RETURN = 6;     // UI: aantal bronnen mee terug
const DEFAULT_MAX_EXCERPTS_FETCH = 6;     // “lezen” (adaptief) — niet hard 2
const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;

const WABO_ID = "BWBR0024779";

function nowMs() { return Date.now(); }

function cleanupStores() {
  const now = nowMs();

  for (const [sid, v] of pendingStore.entries()) {
    const createdAt = Number(v?.createdAt || 0);
    if (!createdAt || (now - createdAt) > 10 * 60 * 1000) pendingStore.delete(sid);
  }

  for (const [ip, v] of rateStore.entries()) {
    const resetAt = Number(v?.resetAt || 0);
    if (!resetAt || now > (resetAt + 2 * 60 * 1000)) rateStore.delete(ip);
  }

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

function dedupeByLink(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr || []) {
    if (!s?.link) continue;
    if (seen.has(s.link)) continue;
    seen.add(s.link);
    out.push(s);
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

function pickRelevantLines(text, keywords, maxLines = 22) {
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

// ---------------------------
// SRU searches
// ---------------------------
async function cvdrSearch({ municipalityName, topicText, fetchWithTimeout, max = 25 }) {
  const base = "https://zoekdienst.overheid.nl/sru/Search";
  const creatorsToTry = [
    municipalityName,
    `Gemeente ${municipalityName}`,
    `gemeente ${municipalityName}`,
  ].filter(Boolean);

  const safeTopic = (topicText || "").replaceAll('"', "").trim() || "";

  for (const creator of creatorsToTry) {
    const cql = `(dcterms.creator="${creator}") AND (keyword all "${safeTopic}")`;
    const url =
      `${base}?version=1.2&operation=searchRetrieve&x-connection=cvdr&x-info-1-accept=any` +
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
  const base = "https://zoekservice.overheid.nl/sru/Search";
  const url =
    `${base}?version=1.2&operation=searchRetrieve&x-connection=BWB` +
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
// Excerpt fetching (cached)
// ---------------------------
async function fetchExcerptForSource({ source, keywords, fetchWithTimeout }) {
  const cacheKey = `ex:${source.id}:${(keywords || []).join("|").slice(0, 120)}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  try {
    const resp = await fetchWithTimeout(source.link, {}, 15000);
    const html = await resp.text();
    const text = htmlToTextLite(html);
    const excerpt = pickRelevantLines(text, keywords, 22);
    const out = excerpt ? excerpt.slice(0, 3200) : null;
    cacheSet(cacheKey, out, EXCERPT_TTL_MS);
    return out;
  } catch {
    cacheSet(cacheKey, null, 15 * 60 * 1000);
    return null;
  }
}

// ---------------------------
// OpenAI helpers
// ---------------------------
async function callOpenAI({ apiKey, fetchWithTimeout, model, messages, temperature = 0.2, max_tokens = 700 }) {
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

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function ensureTwoHeadings(answer) {
  const a = (answer || "").trim();
  const lc = a.toLowerCase();
  if (lc.includes("antwoord:") && lc.includes("toelichting:")) return a;
  return ["Antwoord:", a || "Ik kan hier nog geen goed antwoord op geven.", "", "Toelichting:", "- Kun je iets meer context geven?"].join("\n");
}

// ---------------------------
// 1) AI “planner”: bepaalt wat te doen + welke info ontbreekt
// ---------------------------
async function planQuery({ apiKey, fetchWithTimeout, chatMessages, pending }) {
  const system = `
Je bent Beleidsbank: een hulpvaardige assistent voor Nederlandse wet- en regelgeving en beleid (landelijk + gemeentelijk).
Je praat soepel (zoals ChatGPT): als de vraag duidelijk is, antwoord direct. Als de vraag te vaag is, stel 1–3 gerichte vragen.

Maak een PLAN in JSON (alleen JSON, geen tekst eromheen) met velden:
{
  "scope": "national" | "municipal" | "mixed",
  "needs_followup": boolean,
  "followup_questions": string[],
  "slots_needed": string[],               // bv ["municipality","timeframe"]
  "slots_collected": { "municipality"?: string, "timeframe"?: string },
  "search": {
    "use_bwb": boolean,
    "use_cvdr": boolean,
    "municipality": string|null,          // als scope municipal/mixed
    "query_terms": string[],              // keywords voor zoeken + excerpt
    "bwb_cql": string|null,               // optioneel (anders JS maakt simpele CQL)
    "cvdr_topic": string|null
  },
  "historical_mode": boolean,             // true als user expliciet oud recht/overgangsrecht vraagt of datum < 2024 relevant is
  "allow_wabo": boolean                   // true als user Wabo noemt of historical_mode true
}

Regels:
- Wabo NIET standaard gebruiken; alleen als allow_wabo true.
- Als scope municipal/mixed en municipality ontbreekt: geef wel een algemeen antwoord, en vraag daarna om de gemeente.
- Vraag niet onnodig door bij een duidelijke vraag.
`.trim();

  const user = `
CHAT (laatste berichten):
${JSON.stringify(chatMessages.slice(-8))}

PENDING (als aanwezig):
${JSON.stringify(pending || null)}

Geef alleen het PLAN-JSON.
`.trim();

  const resp = await callOpenAI({
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

  if (!resp.ok) return { ok: false, error: resp.raw };

  const plan = safeJsonParse(resp.content);
  if (!plan) return { ok: false, error: `Planner JSON ongeldig: ${resp.content}` };
  return { ok: true, plan };
}

// ---------------------------
// 2) AI “answerer”: antwoord op basis van bronnen+excerpts
// ---------------------------
async function answerWithEvidence({ apiKey, fetchWithTimeout, chatMessages, plan, sourcesPack }) {
  const system = `
Je beantwoordt vragen over Nederlandse wet- en regelgeving en beleid.

Belangrijk:
- Noem ALLEEN artikel-/lidverwijzingen als die letterlijk in de aangeleverde uittreksels staan.
- Als uittreksels geen expliciete norm tonen: geef wel een praktisch antwoord, maar formuleer voorzichtig en leg uit welke info ontbreekt.
- Antwoord soepel en menselijk (zoals ChatGPT), maar compact.

Output (ALLEEN):
Antwoord:
Toelichting:
`.trim();

  const user = `
PLAN:
${JSON.stringify(plan, null, 2)}

BRONNEN + UITTREKSELS:
${sourcesPack}

CHAT:
${JSON.stringify(chatMessages.slice(-8))}
`.trim();

  return await callOpenAI({
    apiKey,
    fetchWithTimeout,
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
}

// ---------------------------
// MAIN
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

  // IP + rate limit
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  // Input
  const body = req.body || {};
  const sessionId = (body.session_id || "").toString().trim();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt." });

  let messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    const msg = (body.message || "").toString().trim();
    if (!msg) return res.status(400).json({ error: "Missing messages/message" });
    messages = [{ role: "user", content: msg }];
  }

  const fetchWithTimeout = makeFetchWithTimeout();

  // Pending (slot-filling) koppelen
  const pending = sessionId ? pendingStore.get(sessionId) : null;
  const fresh = pending && (nowMs() - pending.createdAt) < 10 * 60 * 1000;

  // Combineer chat met pending-messages (zodat gesprek voelt als “doorlopend”)
  let chatMessages = messages;
  if (fresh && Array.isArray(pending.messages)) {
    chatMessages = [...pending.messages, ...messages].slice(-12);
  }

  // 1) Plan
  const planned = await planQuery({ apiKey, fetchWithTimeout, chatMessages, pending: fresh ? pending : null });
  if (!planned.ok) {
    return res.status(200).json({
      answer: ensureTwoHeadings([
        "Antwoord:",
        "Ik liep vast bij het analyseren van je vraag.",
        "",
        "Toelichting:",
        "- Probeer je vraag iets concreter te formuleren."
      ].join("\n")),
      sources: []
    });
  }
  const plan = planned.plan;

  // Pending opslaan als follow-up nodig is (maar we kunnen ook alvast algemeen antwoorden)
  if (sessionId) {
    const collected = { ...(pending?.collected || {}), ...(plan?.slots_collected || {}) };
    const missing = Array.isArray(plan?.slots_needed) ? plan.slots_needed : [];

    if (plan.needs_followup && missing.length) {
      pendingStore.set(sessionId, {
        missing,
        collected,
        messages: chatMessages,
        createdAt: nowMs()
      });
    } else {
      pendingStore.delete(sessionId);
    }
  }

  // 2) Sources zoeken (AI zegt welke systemen)
  const useBwb = !!plan?.search?.use_bwb;
  const useCvdr = !!plan?.search?.use_cvdr;
  const municipality = plan?.search?.municipality || plan?.slots_collected?.municipality || pending?.collected?.municipality || null;

  const queryTerms = Array.isArray(plan?.search?.query_terms) ? plan.search.query_terms.filter(Boolean) : [];
  const keywords = queryTerms.length ? queryTerms.slice(0, 12) : ["vergunning", "verordening", "beleidsregel"];

  let sources = [];

  // BWB
  if (useBwb) {
    // Simpele default CQL als planner geen cql geeft
    const cql =
      plan?.search?.bwb_cql ||
      (queryTerms.length
        ? queryTerms.slice(0, 6).map(t => `overheidbwb.titel any "${String(t).replaceAll('"', "")}"`).join(" OR ")
        : `overheidbwb.titel any "Omgevingswet"`);

    const bwb = await bwbSruSearch({ cql, fetchWithTimeout, max: 25 });

    // Wabo: niet bannen, maar filteren tenzij allow_wabo
    const allowWabo = !!plan?.allow_wabo;
    const filtered = allowWabo ? bwb : bwb.filter(x => (x.id || "").toUpperCase() !== WABO_ID);

    sources.push(...filtered);
  }

  // CVDR
  if (useCvdr) {
    const topic = plan?.search?.cvdr_topic || queryTerms.join(" ") || chatMessages.at(-1)?.content || "";
    if (municipality) {
      const cvdr = await cvdrSearch({ municipalityName: municipality, topicText: topic, fetchWithTimeout });
      sources.push(...cvdr);
    }
  }

  sources = dedupeByLink(sources);

  // Limit wat we teruggeven in UI
  const safeSources = sources.slice(0, DEFAULT_MAX_SOURCES_RETURN);

  // 3) Excerpts ophalen (adaptief, max 6)
  const toRead = sources.slice(0, DEFAULT_MAX_EXCERPTS_FETCH);
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

  // 4) Antwoord genereren
  const ai = await answerWithEvidence({ apiKey, fetchWithTimeout, chatMessages, plan, sourcesPack });

  if (!ai.ok) {
    const fallback = ensureTwoHeadings([
      "Antwoord:",
      "Ik kan nu geen volledig antwoord genereren door een tijdelijke fout, maar ik kan het opnieuw proberen als je je vraag herhaalt of iets specifieker maakt.",
      "",
      "Toelichting:",
      "- Voeg eventueel context toe (locatie/gemeente, activiteit, periode)."
    ].join("\n"));
    return res.status(200).json({ answer: fallback, sources: safeSources });
  }

  // Als follow-up nodig: voeg die vragen toe in Toelichting (zonder hardcode onderwerp)
  let answer = ensureTwoHeadings(ai.content);
  const followups = Array.isArray(plan?.followup_questions) ? plan.followup_questions.filter(Boolean) : [];
  if (plan?.needs_followup && followups.length) {
    answer += `\n\nToelichting:\n- ${followups.join("\n- ")}`;
    answer = ensureTwoHeadings(answer); // her-ensure (simpel)
  }

  return res.status(200).json({
    answer,
    sources: safeSources
  });
}
