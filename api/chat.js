// /api/chat.js — Beleidsbank V1 (Simple, Source-grounded, AI-led)
// Next.js API route / Node runtime.
//
// INPUT:
// { session_id?: string, message: string }
//
// OUTPUT:
// { answer: string, sources: [{n,id,title,link,type,excerpt}] }
//
// Guarantees:
// - sources[] are official docs from wetten.overheid.nl (BWB) and lokaleregelgeving.overheid.nl (CVDR)
// - answer references only these sources using [n]
// - no hardcoded topic keyword lists in JS

const SRU_BWB_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search";
const SRU_CVDR_ENDPOINT = "https://zoekdienst.overheid.nl/sru/Search";

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const MAX_MESSAGE_CHARS = 2000;

const SRU_MAX_RECORDS = 25;         // how many SRU records per source (BWB/CVDR) we pull
const CANDIDATE_MAX = 25;           // how many candidates we consider total after merge
const EXCERPTS_FETCH = 10;          // how many documents we actually fetch excerpts from
const UI_SOURCES_MAX = 10;          // how many sources returned to UI
const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;

const rateStore = new Map();        // ip -> {count, resetAt}
const excerptCache = new Map();     // key -> {value, expiresAt}

function nowMs() { return Date.now(); }

function cleanupStores() {
  const now = nowMs();
  for (const [ip, v] of rateStore.entries()) {
    if (!v || now > v.resetAt + RATE_WINDOW_MS * 2) rateStore.delete(ip);
  }
  for (const [k, v] of excerptCache.entries()) {
    if (!v || now > v.expiresAt) excerptCache.delete(k);
  }
}

function rateLimit(ip) {
  const now = nowMs();
  const item = rateStore.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + RATE_WINDOW_MS;
  }
  item.count++;
  rateStore.set(ip, item);
  return item.count <= RATE_LIMIT;
}

function makeFetchWithTimeout() {
  return async (url, options = {}, ms = 15000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, {
        redirect: "follow",
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "Beleidsbank/1.0 (+https://beleidsbank.nl)",
          ...(options.headers || {}),
        },
      });
    } finally {
      clearTimeout(id);
    }
  };
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function normalize(s) {
  return (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = normalize(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function decodeXmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#([0-9]+);/g, (_, num) => {
      try { return String.fromCodePoint(parseInt(num, 10)); } catch { return ""; }
    });
}

function firstMatch(text, regex) {
  const m = (text || "").match(regex);
  return m ? m[1] : null;
}

async function callOpenAI({ apiKey, fetchWithTimeout, messages, max_tokens = 700, temperature = 0.2 }) {
  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature,
        max_tokens,
        messages,
      }),
    },
    20000
  );

  const raw = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, raw };
  try {
    const json = JSON.parse(raw);
    return { ok: true, content: (json?.choices?.[0]?.message?.content || "").trim() };
  } catch (e) {
    return { ok: false, status: 500, raw: `JSON parse failed: ${String(e)}\nRAW:\n${raw}` };
  }
}

function stripModelLeakage(text) {
  if (!text) return text;
  return text
    .replace(/you are trained on data up to.*$/gmi, "")
    .replace(/as an ai language model.*$/gmi, "")
    .replace(/als (een )?ai(-| )?taalmodel.*$/gmi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeInlineCitations(answer, maxN) {
  if (!answer) return answer;
  const cleaned = answer.replace(/\[(\d+)\]/g, (m, n) => {
    const i = parseInt(n, 10);
    if (Number.isFinite(i) && i >= 1 && i <= maxN) return m;
    return "";
  });
  return cleaned.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------- SRU ----------------

async function sruSearch({ endpoint, connection, cql, fetchWithTimeout, maximumRecords = SRU_MAX_RECORDS }) {
  const url =
    `${endpoint}?version=1.2&operation=searchRetrieve` +
    `&x-connection=${encodeURIComponent(connection)}` +
    `&x-info-1-accept=any` +
    `&startRecord=1&maximumRecords=${maximumRecords}` +
    `&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url, {}, 12000);
  return await resp.text();
}

function parseSruRecords(xml, collectionType) {
  const records = (xml || "").match(/<record(?:\s[^>]*)?>[\s\S]*?<\/record>/g) || [];
  const out = [];

  for (const rec of records) {
    const id =
      firstMatch(rec, /<dcterms:identifier>([^<]+)<\/dcterms:identifier>/) ||
      firstMatch(rec, /<identifier>([^<]+)<\/identifier>/);

    const titleRaw =
      firstMatch(rec, /<dcterms:title>([\s\S]*?)<\/dcterms:title>/) ||
      firstMatch(rec, /<title>([\s\S]*?)<\/title>/);

    const title = decodeXmlEntities((titleRaw || "").replace(/<[^>]+>/g, "").trim());
    if (!id || !title) continue;

    if (collectionType === "BWB" && !/^BWBR/i.test(id)) continue;
    if (collectionType === "CVDR" && !/^CVDR/i.test(id)) continue;

    const link =
      collectionType === "BWB"
        ? `https://wetten.overheid.nl/${id}`
        : `https://lokaleregelgeving.overheid.nl/${id}`;

    out.push({ id, title, link, type: collectionType });
  }

  // hard dedupe by type+id
  const seen = new Set();
  return out.filter((x) => {
    const k = `${x.type}:${x.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------- Excerpts ----------------

function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6|tr|td)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildExcerpt(text, terms, maxChars = 2200) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const termSet = uniqStrings((terms || []).map(normalize)).filter((t) => t && t.length >= 3);
  if (!termSet.length) return lines.slice(0, 30).join("\n").slice(0, maxChars);

  const scored = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = normalize(lines[i]);
    let s = 0;
    for (const t of termSet) if (ln.includes(t)) s++;
    if (s > 0) scored.push({ i, s });
  }

  if (!scored.length) return lines.slice(0, 35).join("\n").slice(0, maxChars);

  scored.sort((a, b) => b.s - a.s);

  const idx = new Set();
  for (const it of scored.slice(0, 12)) {
    idx.add(it.i);
    if (it.i > 0) idx.add(it.i - 1);
    if (it.i + 1 < lines.length) idx.add(it.i + 1);
  }

  const ordered = [...idx].sort((a, b) => a - b).map((i) => lines[i]);
  let excerpt = ordered.join("\n");
  if (excerpt.length > maxChars) excerpt = excerpt.slice(0, maxChars);
  return excerpt;
}

async function fetchExcerpt({ src, terms, fetchWithTimeout }) {
  const cacheKey = `ex:${src.type}:${src.id}:${terms.map(normalize).join("|").slice(0, 120)}`;
  const cached = excerptCache.get(cacheKey);
  if (cached && nowMs() < cached.expiresAt) return cached.value;

  try {
    const resp = await fetchWithTimeout(src.link, { headers: { Range: "bytes=0-500000" } }, 15000);
    const html = await resp.text();
    const text = htmlToTextLite(html.length > 1_000_000 ? html.slice(0, 1_000_000) : html);
    const ex = buildExcerpt(text, terms, 2200);
    const value = ex || "";
    excerptCache.set(cacheKey, { value, expiresAt: nowMs() + EXCERPT_TTL_MS });
    return value;
  } catch {
    excerptCache.set(cacheKey, { value: "", expiresAt: nowMs() + 15 * 60 * 1000 });
    return "";
  }
}

// ---------------- AI-led planning + AI-led selection ----------------

async function aiPlan({ apiKey, fetchWithTimeout, question }) {
  const system = `
Je bent retrieval-planner voor Beleidsbank (NL wetgeving/beleid).

Geef ALLEEN JSON:
{
  "search_terms": string[],             // 6-10 kerntermen uit de vraag (geen stopwoorden)
  "municipality": string|null,          // gemeente als expliciet genoemd, anders null
  "want_local": boolean,                // of lokale regels waarschijnlijk relevant zijn
  "bwb_cql": string,                    // CQL voor BWB (compact)
  "cvdr_topic": string                  // korte topic string voor CVDR (als municipality bekend)
}

Regels:
- Leid alles af uit de vraag (geen hardcoded voorbeelden).
- bwb_cql gebruikt vooral: overheidbwb.titel any "term" OR ...
- Als onderwerp waarschijnlijk lokaal is (APV/evenement/horeca/bouwen in omgevingsplan): want_local=true.
`.trim();

  const r = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 350,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: question },
    ],
  });

  if (!r.ok) return null;
  const plan = safeJsonParse(r.content);
  if (!plan) return null;

  const search_terms = Array.isArray(plan.search_terms) ? uniqStrings(plan.search_terms).slice(0, 10) : [];
  const municipality = plan.municipality ? String(plan.municipality).trim() : null;
  const want_local = !!plan.want_local;

  let bwb_cql = typeof plan.bwb_cql === "string" ? plan.bwb_cql.trim() : "";
  if (!bwb_cql) {
    const terms = search_terms.slice(0, 8).map(t => t.replaceAll('"', ""));
    bwb_cql = terms.length
      ? `(${terms.map(t => `overheidbwb.titel any "${t}"`).join(" OR ")})`
      : `overheidbwb.titel any "Omgevingswet"`;
  }
  if (bwb_cql.length > 700) bwb_cql = bwb_cql.slice(0, 700);

  const cvdr_topic = typeof plan.cvdr_topic === "string" ? plan.cvdr_topic.slice(0, 120) : search_terms.slice(0, 5).join(" ");

  return { search_terms, municipality, want_local, bwb_cql, cvdr_topic };
}

async function aiSelectSources({ apiKey, fetchWithTimeout, question, candidates }) {
  // AI selects which candidate docs are relevant BEFORE we fetch excerpts (saves time and improves quality)
  const system = `
Je kiest relevante officiële documenten voor een vraag over NL wetgeving/beleid.

Je krijgt:
- de vraag
- candidate docs (id,title,type,link)

Kies maximaal 10 ids die het meest relevant zijn om de vraag te beantwoorden.
Geef ALLEEN JSON:
{ "selected_ids": string[] }
`.trim();

  const payload = {
    question,
    candidates: (candidates || []).slice(0, CANDIDATE_MAX).map(c => ({
      id: c.id, title: c.title, type: c.type, link: c.link
    })),
  };

  const r = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 250,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  if (!r.ok) return null;
  const js = safeJsonParse(r.content);
  if (!js || !Array.isArray(js.selected_ids)) return null;
  return uniqStrings(js.selected_ids).slice(0, 10);
}

async function aiAnswer({ apiKey, fetchWithTimeout, question, plan, sources }) {
  const system = `
Je bent Beleidsbank.

Je krijgt:
- vraag
- bronnen [1..N] met officiële link + excerpt

Schrijf een globaal, praktisch antwoord in het Nederlands.
Vereisten:
- Gebruik inline bronverwijzingen [1], [2], ... ALLEEN als de claim steun vindt in het excerpt.
- Als iets niet zeker is uit excerpts: zeg dat, en wijs naar de bron om na te lezen.
- Noem geen trainingsdata, geen "als AI".

Output: gewone tekst.
`.trim();

  const payload = {
    question,
    plan,
    sources: (sources || []).map((s, idx) => ({
      n: idx + 1,
      id: s.id,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt || "",
    })),
  };

  const r = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 900,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  if (!r.ok) return null;
  return r.content;
}

// ---------------- handler ----------------

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
  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  const body = typeof req.body === "string" ? safeJsonParse(req.body) || {} : req.body || {};
  const message = (body.message || body.messages?.at(-1)?.content || "").toString().trim();
  if (!message) return res.status(400).json({ error: "Missing message" });
  if (message.length > MAX_MESSAGE_CHARS) return res.status(413).json({ error: "Message too long" });

  const fetchWithTimeout = makeFetchWithTimeout();

  // 1) AI plan
  const plan = await aiPlan({ apiKey, fetchWithTimeout, question: message });
  const safePlan = plan || {
    search_terms: uniqStrings(message.split(/\s+/)).slice(0, 10),
    municipality: null,
    want_local: true,
    bwb_cql: `overheidbwb.titel any "Omgevingswet"`,
    cvdr_topic: uniqStrings(message.split(/\s+/)).slice(0, 5).join(" "),
  };

  // 2) SRU search BWB
  let bwb = [];
  try {
    const xml = await sruSearch({
      endpoint: SRU_BWB_ENDPOINT,
      connection: "BWB",
      cql: safePlan.bwb_cql,
      fetchWithTimeout,
      maximumRecords: SRU_MAX_RECORDS,
    });
    bwb = parseSruRecords(xml, "BWB");
  } catch { bwb = []; }

  // 3) SRU search CVDR only if municipality known
  let cvdr = [];
  if (safePlan.want_local && safePlan.municipality) {
    try {
      const mun = safePlan.municipality.replaceAll('"', "");
      const creatorClause = `(dcterms.creator="${mun}" OR dcterms.creator="Gemeente ${mun}")`;
      const topic = (safePlan.cvdr_topic || "").replaceAll('"', "").trim() || mun;
      const cql = `(${creatorClause} AND keyword all "${topic}")`;

      const xml = await sruSearch({
        endpoint: SRU_CVDR_ENDPOINT,
        connection: "cvdr",
        cql,
        fetchWithTimeout,
        maximumRecords: SRU_MAX_RECORDS,
      });
      cvdr = parseSruRecords(xml, "CVDR");
    } catch { cvdr = []; }
  }

  // 4) merge candidates
  const merged = [...bwb, ...cvdr];
  const candSeen = new Set();
  const candidates = [];
  for (const c of merged) {
    const k = `${c.type}:${c.id}`;
    if (candSeen.has(k)) continue;
    candSeen.add(k);
    candidates.push(c);
    if (candidates.length >= CANDIDATE_MAX) break;
  }

  // 5) AI selects which docs to actually read
  let selectedIds = await aiSelectSources({ apiKey, fetchWithTimeout, question: message, candidates });
  if (!selectedIds || !selectedIds.length) {
    selectedIds = candidates.slice(0, EXCERPTS_FETCH).map(c => c.id);
  }

  const selected = [];
  const selectedSet = new Set(selectedIds);
  for (const c of candidates) {
    if (selectedSet.has(c.id)) selected.push(c);
    if (selected.length >= EXCERPTS_FETCH) break;
  }
  if (!selected.length) selected.push(...candidates.slice(0, EXCERPTS_FETCH));

  // 6) fetch excerpts from the exact official pages
  const termsForExcerpt = uniqStrings([...(safePlan.search_terms || []), message])
    .join(" ")
    .split(/\s+/)
    .slice(0, 14);

  const sourcesWithEx = [];
  for (const src of selected) {
    const excerpt = await fetchExcerpt({ src, terms: termsForExcerpt, fetchWithTimeout });
    sourcesWithEx.push({ ...src, excerpt: (excerpt || "").trim() });
  }

  // sort: sources with real excerpt first
  sourcesWithEx.sort((a, b) => (b.excerpt?.length || 0) - (a.excerpt?.length || 0));

  // trim for UI and answer
  const usedSources = sourcesWithEx.slice(0, EXCERPTS_FETCH);

  // 7) answer based on these sources
  let answer = "";
  const aiText = await aiAnswer({ apiKey, fetchWithTimeout, question: message, plan: safePlan, sources: usedSources });

  if (aiText) {
    answer = sanitizeInlineCitations(stripModelLeakage(aiText), usedSources.length);
  } else {
    answer =
      "Ik kon nu geen antwoord genereren op basis van de opgehaalde uittreksels. " +
      "Bekijk de onderstaande bronnen om de relevante bepalingen te vinden.";
    if (safePlan.want_local && !safePlan.municipality) {
      answer += " Let op: lokale regels verschillen per gemeente. Noem de gemeente voor lokale regelgeving.";
    }
  }

  // 8) return sources (official + excerpt)
  const sourcesOut = usedSources.slice(0, UI_SOURCES_MAX).map((s, idx) => ({
    n: idx + 1,
    id: s.id,
    title: s.title,
    link: s.link,
    type: s.type,         // "BWB" or "CVDR"
    excerpt: s.excerpt || "",
  }));

  return res.status(200).json({
    answer,
    sources: sourcesOut,
  });
}
