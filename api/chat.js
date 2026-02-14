// /api/chat.js — Beleidsbank V1 (algemeen, bron-gedreven, stabiele citations, geen hardcoded “terras/evenement” antwoorden)
// Next.js API route (Node runtime)
//
// Doel V1:
// - Vraag → haal officiële bronnen op (BWB + CVDR als gemeente herleidbaar)
// - Haal excerpts (tekstsnippets) uit die bronnen
// - Laat AI: (1) beste bronnen kiezen, (2) antwoord formuleren met echte [1]..[N] citations
// - Output: { answer, sources:[{n,id,title,link,type,excerpt}] }
//
// Belangrijk: dit is algemeen. Er zitten geen “dakkapel/markt/terras” hardcoded antwoorden in.
// Enige “sturing” is generiek retrieval (stopwoorden, dedupe, excerpt windows, citation enforcement).

const SRU_BWB_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search"; // x-connection=BWB
const SRU_CVDR_ENDPOINT = "https://zoekdienst.overheid.nl/sru/Search"; // x-connection=cvdr
const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_MESSAGE_CHARS = 2000;

// Retrieval tuning (V1)
const SRU_MAX_RECORDS = 60;
const MAX_CANDIDATES = 80;
const EXCERPTS_FETCH = 16;
const UI_SOURCES_MAX = 8;

const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;

const rateStore = new Map();
const excerptCache = new Map();

// --------------------- utils ---------------------
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
          "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.7",
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

function uniqBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = keyFn(x);
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
  const cleaned = answer
    .replace(/\[n\]/gi, "") // kill placeholders
    .replace(/\[(\d+)\]/g, (m, n) => {
      const i = parseInt(n, 10);
      if (Number.isFinite(i) && i >= 1 && i <= maxN) return m;
      return "";
    });
  return cleaned.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function hasRealCitations(text) {
  return /\[(\d+)\]/.test(text || "");
}

// --------------------- gemeente extractie (licht, algemeen) ---------------------
function titleCase(s) {
  return (s || "")
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .trim();
}

function extractMunicipality(message) {
  const text = (message || "").toString();

  // “gemeente X”
  let m = text.match(/\bgemeente\s+([A-Za-zÀ-ÿ'\-]+(?:\s+[A-Za-zÀ-ÿ'\-]+){0,3})/i);
  if (m?.[1]) return titleCase(m[1]);

  // “in X” (kapitalisatie)
  m = text.match(/\b(?:in|te|bij)\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+){0,3})/);
  if (m?.[1]) return titleCase(m[1]);

  return null;
}

// --------------------- term extraction (algemeen) ---------------------
const STOPWORDS = new Set([
  "de","het","een","en","of","maar","als","dan","dat","dit","die","er","hier","daar","waar","wanneer",
  "ik","jij","je","u","uw","we","wij","zij","ze","mijn","jouw","zijn","haar","hun","ons","onze",
  "mag","mogen","moet","moeten","kun","kunnen","kan","zal","zullen","wil","willen",
  "zonder","met","voor","van","op","in","aan","bij","naar","tot","tegen","over","door","om","uit","binnen",
  "wat","welke","wie","waarom","hoe","hoelang","hoeveel","wel","niet","geen","ja",
  // generieke juridische woorden die vaak ruis geven in titel-search
  "wet","beleid","regels","regel","verordening","toestemming","vergunning","aanvraag","aanvragen",
]);

function extractTerms(q, max = 10) {
  const raw = (q || "")
    .toString()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = raw.split(" ").map(t => normalize(t)).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (/^\d+$/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// --------------------- SRU ---------------------
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

  return out;
}

// --------------------- scoring (algemeen) ---------------------
// Hard ruisfilter voor bekende mis-hits (belasting etc.)
const TITLE_NOISE = [
  "inkomstenbelasting",
  "kapitaalverzekering",
  "spaarrekening",
  "beleggingsrecht",
  "box 3",
  "kew",
  "overgangstermijn",
];

function scoreSource(src, terms, municipality) {
  const t = normalize(src.title);
  let score = 0;

  // basisgewicht
  score += src.type === "CVDR" ? 6 : 3;

  // ruis hard omlaag
  for (const w of TITLE_NOISE) if (t.includes(w)) score -= 200;

  // term match
  for (const term of (terms || [])) {
    const tn = normalize(term);
    if (tn && t.includes(tn)) score += 8;
  }

  // algemene preferentie: APV/verordening is vaak “regelset” bij CVDR
  if (src.type === "CVDR" && (t.includes("verordening") || t.includes("algemene plaatselijke verordening") || t.includes(" apv"))) {
    score += 25;
  }

  // als er een gemeente is en het is CVDR: iets hoger
  if (municipality && src.type === "CVDR") score += 8;

  return score;
}

// --------------------- excerpt extraction (algemeen: keyword-windows) ---------------------
function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6|tr|td|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildKeywordWindows(text, keywords, maxWindows = 4, windowLines = 10, maxChars = 2600) {
  const lines = (text || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return "";

  const keys = (keywords || []).map(normalize).filter(k => k && k.length >= 3);
  if (!keys.length) return lines.slice(0, 60).join("\n").slice(0, maxChars);

  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const lc = normalize(lines[i]);
    if (keys.some(k => lc.includes(k))) hits.push(i);
  }

  if (!hits.length) return lines.slice(0, 70).join("\n").slice(0, maxChars);

  const picked = [];
  for (const idx of hits) {
    if (!picked.length || Math.abs(idx - picked[picked.length - 1]) > windowLines * 2) {
      picked.push(idx);
      if (picked.length >= maxWindows) break;
    }
  }

  const chunks = [];
  for (const center of picked) {
    const start = Math.max(0, center - windowLines);
    const end = Math.min(lines.length, center + windowLines + 1);
    chunks.push(lines.slice(start, end).join("\n"));
  }

  let out = chunks.join("\n\n---\n\n");
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

async function fetchExcerpt({ src, keywords, fetchWithTimeout }) {
  const cacheKey = `ex:${src.type}:${src.id}:${keywords.map(normalize).join("|").slice(0, 200)}`;
  const cached = excerptCache.get(cacheKey);
  if (cached && nowMs() < cached.expiresAt) return cached.value;

  try {
    // Key: geen Range bij CVDR (client-side/structuur issues)
    const headers = src.type === "BWB" ? { Range: "bytes=0-1600000" } : {};
    const resp = await fetchWithTimeout(src.link, { headers }, 18000);
    const html = await resp.text();

    const cut = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
    const text = decodeXmlEntities(htmlToTextLite(cut));

    const excerpt = buildKeywordWindows(text, keywords, 4, 10, 2600);
    const value = excerpt || "";
    excerptCache.set(cacheKey, { value, expiresAt: nowMs() + EXCERPT_TTL_MS });
    return value;
  } catch {
    excerptCache.set(cacheKey, { value: "", expiresAt: nowMs() + 15 * 60 * 1000 });
    return "";
  }
}

// --------------------- OpenAI ---------------------
async function callOpenAI({ apiKey, fetchWithTimeout, messages, max_tokens = 700, temperature = 0.2 }) {
  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", temperature, max_tokens, messages }),
    },
    20000
  );

  const raw = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, raw };

  try {
    const json = JSON.parse(raw);
    return { ok: true, content: (json?.choices?.[0]?.message?.content || "").trim() };
  } catch {
    return { ok: false, status: 500, raw };
  }
}

function answerSystemPrompt() {
  return `
Je bent Beleidsbank. Antwoord uitsluitend op basis van de meegeleverde officiële bronnen met uittreksels.

Harde regels:
- Citeer alleen met echte nummers: [1], [2], ... zoals in de sources.
- Gebruik NOOIT placeholders zoals [n], [bron], [source].
- Gebruik [k] alleen als de claim aantoonbaar in het excerpt van bron [k] staat.
- Als een detail niet in de uittreksels staat: zeg dat expliciet en verwijs naar de meest relevante bron(nen) om zelf te lezen.
- Verzin geen artikel-/lidnummers.

Stijl:
- 1 korte alinea antwoord.
- Daarna "Wat te checken:" met 2–4 bullets.
`.trim();
}

async function pickBestSourcesWithAI({ apiKey, fetchWithTimeout, question, sources }) {
  const system = `
Kies de 2 tot 4 beste bronnen om de vraag te beantwoorden, op basis van hun uittreksel.
Vermijd duplicaten (zelfde inhoud).
Output ALLEEN JSON:
{"pick":[1,2,3]}
`.trim();

  const payload = {
    question,
    sources: sources.map(s => ({
      n: s.n,
      title: s.title,
      type: s.type,
      excerpt: (s.excerpt || "").slice(0, 2200),
    })),
  };

  const ai = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 220,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  const parsed = ai.ok ? safeJsonParse(ai.content) : null;
  const pick = Array.isArray(parsed?.pick) ? parsed.pick.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n)) : [];
  const uniqPick = [...new Set(pick)].filter(n => n >= 1 && n <= sources.length).slice(0, 4);
  return uniqPick.length ? uniqPick : sources.slice(0, 3).map(s => s.n);
}

// --------------------- CQL builders (algemeen) ---------------------
function bwbCqlFromTerms(terms) {
  const t = (terms || []).slice(0, 10).map(x => (x || "").replaceAll('"', "").trim()).filter(Boolean);
  if (!t.length) return `overheidbwb.titel any "Algemene wet bestuursrecht"`;
  const clauses = t.map(x => `overheidbwb.titel any "${x}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function cvdrCql({ municipality }) {
  const mun = (municipality || "").replaceAll('"', "").trim();
  const creatorClause = `(dcterms.creator="${mun}" OR dcterms.creator="Gemeente ${mun}")`;
  // algemeen instappunt: verordening/beleidsregel/APV (zonder onderwerp-hardcoding)
  const inner = `(title any "verordening" OR title any "beleidsregel" OR title any "Algemene plaatselijke verordening" OR title any "APV")`;
  return `(${creatorClause} AND ${inner})`;
}

// --------------------- handler ---------------------
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
  const municipality = extractMunicipality(message);

  const terms = extractTerms(message, 10);

  // Keywords voor excerpt windows (algemeen: vraagtermen + juridische signaalwoorden)
  const keywords = uniqBy(
    [...terms, "vergunning", "melding", "ontheffing", "verbod", "toestemming", "voorwaarden", "procedure", "termijn", "kosten", "sanctie", "boete"],
    x => normalize(x)
  ).filter(Boolean).slice(0, 18);

  // 1) SRU search BWB
  let bwb = [];
  try {
    const xml = await sruSearch({
      endpoint: SRU_BWB_ENDPOINT,
      connection: "BWB",
      cql: bwbCqlFromTerms(terms),
      fetchWithTimeout,
      maximumRecords: SRU_MAX_RECORDS,
    });
    bwb = parseSruRecords(xml, "BWB");
  } catch {
    bwb = [];
  }

  // 2) SRU search CVDR (als gemeente herleidbaar)
  let cvdr = [];
  if (municipality) {
    try {
      const xml = await sruSearch({
        endpoint: SRU_CVDR_ENDPOINT,
        connection: "cvdr",
        cql: cvdrCql({ municipality }),
        fetchWithTimeout,
        maximumRecords: SRU_MAX_RECORDS,
      });
      cvdr = parseSruRecords(xml, "CVDR");
    } catch {
      cvdr = [];
    }
  }

  // 3) merge + dedupe (type+id eerst)
  let merged = uniqBy([...cvdr, ...bwb], s => `${s.type}:${s.id}`);

  // 4) rank + cut
  merged = merged
    .map(s => ({ ...s, _score: scoreSource(s, terms, municipality) }))
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, MAX_CANDIDATES);

  // 5) fetch excerpts
  const fetched = [];
  for (const src of merged.slice(0, EXCERPTS_FETCH)) {
    const excerpt = await fetchExcerpt({ src, keywords, fetchWithTimeout });
    fetched.push({ ...src, excerpt: (excerpt || "").trim() });
  }

  // 6) keep useful, dedupe by normalized title to avoid repeated “APV Utrecht” entries
  let useful = uniqBy(
    fetched.filter(s => (s.excerpt || "").length > 120),
    s => `${s.type}:${normalize(s.title)}`
  ).slice(0, UI_SOURCES_MAX);

  // fallback: if excerpts are weak, still return top titles
  if (!useful.length) {
    useful = merged.slice(0, UI_SOURCES_MAX).map(s => ({ ...s, excerpt: "" }));
  }

  // 7) stable numbering 1..N
  const sourcesNumbered = useful.map((s, idx) => ({
    n: idx + 1,
    id: s.id,
    title: s.title,
    link: s.link,
    type: s.type,
    excerpt: s.excerpt || "",
  }));

  // 8) AI selects 2–4 best sources (based on excerpts)
  const picks = await pickBestSourcesWithAI({
    apiKey,
    fetchWithTimeout,
    question: message,
    sources: sourcesNumbered,
  });

  const pickSet = new Set(picks);
  const picked = sourcesNumbered.filter(s => pickSet.has(s.n));
  const pickedSources = picked.length ? picked : sourcesNumbered.slice(0, 3);

  // 9) final answer
  const userPayload = {
    question: message,
    municipality: municipality || null,
    sources: pickedSources.map(s => ({
      n: s.n, title: s.title, link: s.link, type: s.type, excerpt: s.excerpt,
    })),
    note: !municipality ? "Let op: lokale regels kunnen per gemeente verschillen. Noem de gemeente voor lokale regelgeving." : null,
  };

  const ai = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 750,
    temperature: 0.2,
    messages: [
      { role: "system", content: answerSystemPrompt() },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  let answer = ai.ok ? stripModelLeakage(ai.content) : "";
  answer = sanitizeInlineCitations(answer, pickedSources.length);

  // If AI failed to cite at all, retry once with stricter instruction (general, not topic-specific)
  if (ai.ok && !hasRealCitations(answer)) {
    const retry = await callOpenAI({
      apiKey,
      fetchWithTimeout,
      max_tokens: 650,
      temperature: 0.1,
      messages: [
        { role: "system", content: answerSystemPrompt() + "\n\nEXTRA: Gebruik minstens 1 geldige citation [1]..[N] als je iets uit bronnen noemt. Geen placeholders." },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    });

    if (retry.ok) {
      let a2 = stripModelLeakage(retry.content);
      a2 = sanitizeInlineCitations(a2, pickedSources.length);
      if (a2) answer = a2;
    }
  }

  if (!answer) {
    answer =
      "Ik kon op basis van de opgehaalde uittreksels geen zeker antwoord formuleren. " +
      "Bekijk de bronnen hieronder om de relevante bepalingen te vinden.";
  }

  // UX: picked eerst (maar nummering blijft van sourcesNumbered)
  const orderedSources = [
    ...pickedSources,
    ...sourcesNumbered.filter(s => !pickedSources.some(p => p.n === s.n)),
  ];

  return res.status(200).json({
    answer,
    sources: orderedSources,
  });
}
