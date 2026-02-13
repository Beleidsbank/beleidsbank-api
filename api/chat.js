// /api/chat.js — Beleidsbank V1 (WERKEND: stelsel-routing + veel ophalen + AI selecteert top-artikelen + AI antwoordt)
// Next.js API route (Node.js runtime)
//
// Wat dit oplost (jouw problemen):
// - SRU is niet semantisch → daarom minimale “stelsel-routing” om nooit bij belastingwetten te eindigen voor bouw/horeca/evenement.
// - We halen MEER kandidaten op, lezen MEER bronnen uit (maar nog steeds begrensd i.v.m. timeouts).
// - Cruciaal: we laten AI eerst de BESTE 2–3 artikel/excerpt-blokken kiezen uit alles wat we hebben opgehaald.
//   Daardoor stopt de “vaag/veilig” output en krijg je concreter + bron-gedreven antwoorden.
// - Output toont altijd bronnen + excerpts; AI mag alleen citeren met [n] uit die bronnen.
//
// Input:  { session_id?: string, message: string }
// Output: { answer: string, sources: [{n,id,title,link,type,excerpt}] }

const SRU_BWB_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search"; // x-connection=BWB
const SRU_CVDR_ENDPOINT = "https://zoekdienst.overheid.nl/sru/Search"; // x-connection=cvdr

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const MAX_MESSAGE_CHARS = 2000;

// SRU / retrieval tuning
const SRU_MAX_RECORDS = 50;        // haal meer SRU records op
const MAX_CANDIDATES = 60;         // max kandidaten na merge
const EXCERPTS_FETCH = 14;         // lees meer bronnen uit (was 8)
const UI_SOURCES_MAX = 10;         // toon max 10 bronnen in UI

// caching (best effort serverless)
const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;

const rateStore = new Map();
const excerptCache = new Map();

// --------------------- utilities ---------------------
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
  const cleaned = answer.replace(/\[(\d+)\]/g, (m, n) => {
    const i = parseInt(n, 10);
    if (Number.isFinite(i) && i >= 1 && i <= maxN) return m;
    return "";
  });
  return cleaned.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// --------------------- minimal stelsel routing ---------------------
// Dit is bewust klein: niet “dakkapel hardcoded”, maar “welk juridisch stelsel hoort erbij?”
const DOMAIN = {
  BUILD: "build",          // bouwen/omgevingsvergunning/omgevingsplan
  LOCAL_PUBLIC: "local",   // APV/horeca/terras/evenement
  GENERAL: "general",
};

const CORE_TITLES = {
  [DOMAIN.BUILD]: [
    "Omgevingswet",
    "Besluit bouwwerken leefomgeving",
    "Omgevingsbesluit",
    "Besluit activiteiten leefomgeving",
    "Besluit kwaliteit leefomgeving",
  ],
  [DOMAIN.LOCAL_PUBLIC]: [
    // landelijke kaders die soms relevant zijn; lokale details zitten in APV/CVDR
    "Gemeentewet",
    "Algemene wet bestuursrecht",
    "Wet openbare manifestaties",
    "Alcoholwet",
  ],
  [DOMAIN.GENERAL]: [
    "Algemene wet bestuursrecht",
    "Gemeentewet",
  ],
};

function decideDomain(q) {
  const t = normalize(q);
  const buildSignals = [
    "dakkapel","uitbouw","aanbouw","bouw","bouwen","bouwwerk","verbouwen",
    "omgevingsvergunning","vergunningvrij","bopa","omgevingsplan","bouwactiviteit",
    "dakopbouw","bijgebouw","schuur","carport","erker","gevel","monument","welstand",
  ];
  const localSignals = [
    "apv","algemene plaatselijke verordening","evenement","festival","markt","braderie",
    "kermis","terras","horeca","sluitingstijd","sluitingstijden","alcohol","bar","café","cafe",
    "openbare ruimte","openbaar terrein","standplaats",
  ];
  if (buildSignals.some(w => t.includes(w))) return DOMAIN.BUILD;
  if (localSignals.some(w => t.includes(w))) return DOMAIN.LOCAL_PUBLIC;
  return DOMAIN.GENERAL;
}

function titleCase(s) {
  return (s || "")
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .trim();
}

// Best-effort gemeente extractie (alleen om CVDR te activeren)
function extractMunicipality(message) {
  const text = (message || "").toString();

  let m = text.match(/\bgemeente\s+([A-Za-zÀ-ÿ'\-]+(?:\s+[A-Za-zÀ-ÿ'\-]+){0,3})/i);
  if (m?.[1]) return titleCase(m[1]);

  m = text.match(/\b(?:in|te|bij)\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+){0,3})/);
  if (m?.[1]) return titleCase(m[1]);

  return null;
}

// --------------------- query terms ---------------------
const STOPWORDS = new Set([
  "de","het","een","en","of","maar","als","dan","dat","dit","die","er","hier","daar","waar","wanneer",
  "ik","jij","je","u","uw","we","wij","zij","ze","mijn","jouw","zijn","haar","hun","ons","onze",
  "mag","mogen","moet","moeten","kun","kunnen","kan","zal","zullen","wil","willen",
  "zonder","met","voor","van","op","in","aan","bij","naar","tot","tegen","over","door","om","uit","binnen",
  "wat","welke","wie","waarom","hoe","hoelang","hoeveel","wel","niet","geen","ja",
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

// --------------------- SRU search + parsing ---------------------
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

  return uniqBy(out, x => `${x.type}:${x.id}`);
}

// --------------------- ranking ---------------------
// Keiharde penalty voor de ruis die je steeds zag (belastingwetten door "woning")
const TAX_NOISE = [
  "inkomstenbelasting", "kapitaalverzekering", "spaarrekening", "beleggingsrecht", "box 3",
  "overgangstermijn", "kew", "eigen woning",
];

function scoreSource(src, domain) {
  const t = normalize(src.title);
  let score = 0;

  score += (src.type === "BWB") ? 3 : 2;

  for (const w of TAX_NOISE) if (t.includes(w)) score -= 80;

  // Stelsel boost: hiermee voorkom je 90% mis-hits
  for (const core of (CORE_TITLES[domain] || [])) {
    const c = normalize(core);
    if (c && t.includes(c)) score += 120;
  }

  // lichte boosts
  if (t.includes("omgevingswet")) score += 30;
  if (t.includes("besluit bouwwerken leefomgeving") || t.includes("bbl")) score += 24;
  if (t.includes("omgevingsbesluit")) score += 20;
  if (t.includes("apv") || t.includes("algemene plaatselijke verordening")) score += 26;
  if (t.includes("evenement")) score += 10;
  if (t.includes("terras")) score += 10;
  if (t.includes("horeca")) score += 6;
  if (t.includes("verordening")) score += 6;

  return score;
}

// --------------------- excerpt extraction: artikelblokken eerst ---------------------
function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6|tr|td|section|article)>/gi, "\n")
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

function chunkByArticles(text) {
  const clean = (text || "").replace(/\u00a0/g, " ").trim();
  if (!clean) return [];

  const re = /(^|\n)(Artikel|Art\.)\s+([0-9]+[0-9A-Za-z:.\-]*)([^\n]*)/gmi;
  const matches = [...clean.matchAll(re)];
  if (matches.length < 2) return [];

  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + (matches[i][1] ? matches[i][1].length : 0);
    const end = (i + 1 < matches.length) ? matches[i + 1].index : clean.length;
    const block = clean.slice(start, end).trim();
    if (block.length >= 80) blocks.push(block);
  }
  return blocks;
}

function scoreBlock(block, keywords) {
  const b = normalize(block);
  let s = 0;
  for (const k of keywords) {
    const kn = normalize(k);
    if (!kn || kn.length < 3) continue;
    if (b.includes(kn)) s += 2;
  }
  const legalSignals = ["vergunning", "vergunningsvrij", "toestemming", "verboden", "verbod", "ontheffing", "sluiting", "opening", "tijden", "tijdstip"];
  for (const sig of legalSignals) if (b.includes(sig)) s += 1;
  return s;
}

function pickBestArticleBlocks(text, keywords, maxChars = 2600) {
  const blocks = chunkByArticles(text);
  if (!blocks.length) return "";

  const scored = blocks
    .map(bl => ({ bl, s: scoreBlock(bl, keywords) }))
    .sort((a, b) => b.s - a.s);

  const out = [];
  let used = 0;
  for (const it of scored.slice(0, 8)) {
    if (it.s <= 0) continue;
    const add = it.bl.trim();
    if (!add) continue;
    if (used + add.length + 8 > maxChars) continue;
    out.push(add);
    used += add.length + 2;
    if (out.length >= 3) break;
  }

  if (!out.length) {
    for (const bl of blocks.slice(0, 2)) {
      const add = bl.trim();
      if (!add) continue;
      if (used + add.length + 8 > maxChars) break;
      out.push(add);
      used += add.length + 2;
    }
  }

  return out.join("\n\n---\n\n").slice(0, maxChars);
}

function buildLineExcerpt(text, terms, maxChars = 2400) {
  const lines = (text || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return "";

  const keys = uniqBy((terms || []).map(normalize), x => x).filter(x => x && x.length >= 3);
  if (!keys.length) return lines.slice(0, 35).join("\n").slice(0, maxChars);

  const scored = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = normalize(lines[i]);
    let s = 0;
    for (const k of keys) if (ln.includes(k)) s++;
    if (s > 0) scored.push({ i, s });
  }

  if (!scored.length) return lines.slice(0, 40).join("\n").slice(0, maxChars);

  scored.sort((a, b) => b.s - a.s);

  const idx = new Set();
  for (const it of scored.slice(0, 14)) {
    idx.add(it.i);
    if (it.i > 0) idx.add(it.i - 1);
    if (it.i + 1 < lines.length) idx.add(it.i + 1);
  }

  const ordered = [...idx].sort((a, b) => a - b).map(i => lines[i]);
  let out = ordered.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

async function fetchExcerpt({ src, terms, fetchWithTimeout }) {
  const cacheKey = `ex:${src.type}:${src.id}:${terms.map(normalize).join("|").slice(0, 120)}`;
  const cached = excerptCache.get(cacheKey);
  if (cached && nowMs() < cached.expiresAt) return cached.value;

  try {
    const resp = await fetchWithTimeout(src.link, { headers: { Range: "bytes=0-900000" } }, 15000);
    const html = await resp.text();
    const cut = html.length > 1_300_000 ? html.slice(0, 1_300_000) : html;
    const text = htmlToTextLite(cut);

    const articleExcerpt = pickBestArticleBlocks(text, terms, 2600);
    const excerpt = articleExcerpt || buildLineExcerpt(text, terms, 2400);

    const value = excerpt || "";
    excerptCache.set(cacheKey, { value, expiresAt: nowMs() + EXCERPT_TTL_MS });
    return value;
  } catch {
    excerptCache.set(cacheKey, { value: "", expiresAt: nowMs() + 15 * 60 * 1000 });
    return "";
  }
}

// --------------------- OpenAI calls ---------------------
async function callOpenAI({ apiKey, fetchWithTimeout, messages, max_tokens = 900, temperature = 0.2 }) {
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
  } catch (e) {
    return { ok: false, status: 500, raw: `JSON parse failed: ${String(e)}\nRAW:\n${raw}` };
  }
}

// --------------------- CQL builders ---------------------
function bwbCqlFromTerms(terms) {
  const t = (terms || []).slice(0, 10).map(x => (x || "").replaceAll('"', "").trim()).filter(Boolean);
  if (!t.length) return `overheidbwb.titel any "Omgevingswet"`;
  const clauses = t.map(x => `overheidbwb.titel any "${x}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function cvdrCql({ municipality }) {
  const mun = (municipality || "").replaceAll('"', "").trim();
  const creatorClause = `(dcterms.creator="${mun}" OR dcterms.creator="Gemeente ${mun}")`;
  // Breed: APV/verordening/beleidsregel zijn je “entry points” bij alle lokale vragen.
  const inner = `(title any "Algemene plaatselijke verordening" OR title any "APV" OR title any "verordening" OR title any "beleidsregel")`;
  return `(${creatorClause} AND ${inner})`;
}

// --------------------- AI selector (top bronnen kiezen) ---------------------
async function pickBestSourcesWithAI({ apiKey, fetchWithTimeout, question, domain, municipality, sources }) {
  // sources: [{n, id, title, link, type, excerpt}]
  const system = `
Je bent een juridische retrieval-assistent.
Je taak: kies de 2 tot 4 BESTE bronnen (op basis van excerpts) om de vraag te beantwoorden.

REGELS:
- Kies bronnen die daadwerkelijk inhoud bevatten die de vraag beantwoordt.
- Vermijd algemene/overzichtsbronnen als er een concreet artikelblok beschikbaar is.
- Antwoord ALLEEN JSON, exact:
{"pick":[1,2,3],"reason":"...","need_municipality":false}

need_municipality = true alleen als lokale regels essentieel zijn en gemeente ontbreekt.
`.trim();

  const payload = {
    question,
    domain,
    municipality,
    sources: sources.map(s => ({
      n: s.n,
      title: s.title,
      type: s.type,
      id: s.id,
      excerpt: (s.excerpt || "").slice(0, 2600),
    })),
  };

  const ai = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 450,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  if (!ai.ok) return { pick: sources.slice(0, 3).map(s => s.n), need_municipality: false, reason: "fallback" };

  const parsed = safeJsonParse(ai.content);
  if (!parsed || !Array.isArray(parsed.pick)) {
    return { pick: sources.slice(0, 3).map(s => s.n), need_municipality: false, reason: "parse-fallback" };
  }

  const pick = parsed.pick
    .map(x => parseInt(x, 10))
    .filter(n => Number.isFinite(n))
    .filter(n => n >= 1 && n <= sources.length);

  const uniqPick = [...new Set(pick)].slice(0, 4);
  if (!uniqPick.length) uniqPick.push(...sources.slice(0, 3).map(s => s.n));

  return {
    pick: uniqPick,
    need_municipality: !!parsed.need_municipality,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
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

  const domain = decideDomain(message);
  const municipality = extractMunicipality(message);

  // Terms: user terms + stelsel core titles
  const userTerms = extractTerms(message, 10);
  const coreTerms = (CORE_TITLES[domain] || []).map(t => normalize(t));
  const searchTerms = uniqBy([...userTerms, ...coreTerms], x => normalize(x)).slice(0, 14);

  // 1) BWB SRU search (anchored)
  let bwbResults = [];
  try {
    const xml = await sruSearch({
      endpoint: SRU_BWB_ENDPOINT,
      connection: "BWB",
      cql: bwbCqlFromTerms(searchTerms),
      fetchWithTimeout,
      maximumRecords: SRU_MAX_RECORDS,
    });
    bwbResults = parseSruRecords(xml, "BWB");
  } catch { bwbResults = []; }

  // 2) Ensure core docs exist by explicit title queries (guarantee correct legal framework)
  const coreDocs = [];
  for (const ct of (CORE_TITLES[domain] || [])) {
    try {
      const cql = `overheidbwb.titel any "${ct.replaceAll('"', "")}"`;
      const xml = await sruSearch({
        endpoint: SRU_BWB_ENDPOINT,
        connection: "BWB",
        cql,
        fetchWithTimeout,
        maximumRecords: 10,
      });
      const recs = parseSruRecords(xml, "BWB");
      const exact = recs.find(r => normalize(r.title) === normalize(ct));
      if (exact) coreDocs.push(exact);
      else if (recs[0]) coreDocs.push(recs[0]);
    } catch {}
  }

  // 3) CVDR SRU search (alleen als gemeente bekend)
  let cvdrResults = [];
  if (municipality) {
    try {
      const xml = await sruSearch({
        endpoint: SRU_CVDR_ENDPOINT,
        connection: "cvdr",
        cql: cvdrCql({ municipality }),
        fetchWithTimeout,
        maximumRecords: SRU_MAX_RECORDS,
      });
      cvdrResults = parseSruRecords(xml, "CVDR");
    } catch { cvdrResults = []; }
  }

  // 4) Merge + rank candidates
  let candidates = uniqBy([...coreDocs, ...bwbResults, ...cvdrResults], x => `${x.type}:${x.id}`);
  candidates = candidates
    .map(s => ({ ...s, _score: scoreSource(s, domain) }))
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, MAX_CANDIDATES);

  // 5) Fetch excerpts from top N candidates
  const excerptTerms = uniqBy(
    [
      ...userTerms,
      ...((CORE_TITLES[domain] || []).map(t => normalize(t))),
      municipality ? normalize(municipality) : "",
      // legal signals for better article selection
      "vergunning","vergunningsvrij","omgevingsvergunning","toestemming","verbod","ontheffing",
      "sluiting","opening","tijden","tijdstip",
      "evenement","terras","horeca","melding",
    ],
    x => normalize(x)
  ).filter(Boolean).slice(0, 22);

  const toFetch = candidates.slice(0, EXCERPTS_FETCH);
  const withExcerpts = [];
  for (const src of toFetch) {
    const excerpt = await fetchExcerpt({ src, terms: excerptTerms, fetchWithTimeout });
    withExcerpts.push({ ...src, excerpt: (excerpt || "").trim() });
  }

  // 6) Build sources list (numbered)
  const numberedSourcesAll = uniqBy(withExcerpts, x => `${x.type}:${x.id}`)
    .slice(0, UI_SOURCES_MAX)
    .map((s, idx) => ({
      n: idx + 1,
      id: s.id,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt || "",
    }));

  // 7) AI selects best 2–4 sources (THIS is the key)
  const selection = await pickBestSourcesWithAI({
    apiKey,
    fetchWithTimeout,
    question: message,
    domain,
    municipality,
    sources: numberedSourcesAll,
  });

  const pickedSet = new Set(selection.pick);
  const pickedSources = numberedSourcesAll.filter(s => pickedSet.has(s.n));

  // If local domain + no municipality, we still answer globally but hint municipality
  const needsMunicipalityHint =
    (domain === DOMAIN.LOCAL_PUBLIC || domain === DOMAIN.BUILD) &&
    !municipality;

  // 8) Final answer ONLY with pickedSources
  const systemPrompt = `
Je bent Beleidsbank, een assistent voor Nederlandse wet- en regelgeving en beleid.

Je krijgt een VRAAG en een lijst BRONNEN [1..N] met UITTREKSELS.

Harde regels:
- Antwoord uitsluitend op basis van de uittreksels.
- Gebruik [n] alleen als die claim echt gesteund wordt door bron [n].
- Als een detail niet uit de uittreksels blijkt: zeg dat expliciet en verwijs waar de gebruiker het kan nalezen.
- Verzin geen artikel-/lidnummers tenzij letterlijk aanwezig in excerpt.
- Geen meta-tekst (“als AI”, trainingsdata, etc.).

Stijl:
- Kort en nuttig: 1 korte alinea antwoord + 2–4 bullets “Wat te checken”.
`.trim();

  const userPayload = {
    question: message,
    municipality: municipality || null,
    domain,
    note:
      needsMunicipalityHint
        ? "Let op: lokale regels kunnen per gemeente verschillen. Geef gemeente voor exacte lokale bepalingen."
        : null,
    sources: pickedSources.map(s => ({
      n: s.n,
      id: s.id,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: (s.excerpt || "").slice(0, 2600),
    })),
  };

  const ai = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 850,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  let answer = "";
  if (ai.ok) {
    answer = sanitizeInlineCitations(stripModelLeakage(ai.content), pickedSources.length || 1);
    // NOTE: citations [n] are relative to pickedSources numbers (their original n values still shown).
    // We keep original n so sources list matches citations.
  } else {
    answer =
      "Ik kon op dit moment geen antwoord genereren op basis van de opgehaalde uittreksels. " +
      "Bekijk de onderstaande bronnen om de relevante bepalingen te vinden.";
  }

  // 9) Response — show ALL sources (so frontend can show), but mark picked by ordering first
  // We return picked sources first for UX; citations refer to their original [n] numbers.
  const orderedSources = [
    ...pickedSources,
    ...numberedSourcesAll.filter(s => !pickedSet.has(s.n)),
  ];

  return res.status(200).json({
    answer,
    sources: orderedSources,
  });
}
