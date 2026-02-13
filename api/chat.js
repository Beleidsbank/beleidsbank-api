// /api/chat.js — Beleidsbank V1 (Stelsel-routing, werkt in de praktijk)
// Next.js API route (Node runtime).
//
// Filosofie (mijn manier):
// - SRU (BWB/CVDR) is NIET semantisch. Dus: minimale, juridisch-correcte “stelsel-routing”
//   om te voorkomen dat je bij “woning/vergunning” in belastingwetten belandt.
// - Daarna pas: SRU zoeken + excerpts ophalen + 1 AI call die ALLEEN op excerpts antwoordt.
// - Bronnen zijn altijd echte officiële pagina’s (wetten.overheid.nl / lokaleregelgeving.overheid.nl)
// - AI citeert alleen met [n] als het letterlijk steun vindt in excerpt.
//
// INPUT:  { session_id?: string, message: string }
// OUTPUT: { answer: string, sources: [{n,id,title,link,type,excerpt}] }

const SRU_BWB_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search"; // x-connection=BWB
const SRU_CVDR_ENDPOINT = "https://zoekdienst.overheid.nl/sru/Search"; // x-connection=cvdr
const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_MESSAGE_CHARS = 2000;

const SRU_MAX_RECORDS = 25;
const MAX_CANDIDATES = 40;

// We can’t “read everything” (timeouts + token limits). This is a stable V1.
const EXCERPTS_FETCH = 8;  // how many documents we fetch excerpts from
const UI_SOURCES_MAX = 10; // how many sources returned to UI

const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;

const rateStore = new Map();
const excerptCache = new Map();

// --------------------- basics ---------------------
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

// --------------------- minimal “stelsel routing” ---------------------
const DOMAIN = {
  BUILD: "build",
  LOCAL_PUBLIC: "local_public", // APV/evenement/horeca
  GENERAL: "general",
};

// Keep this SMALL. It’s not “dakkapel hardcoding” — it’s the correct legal framework entrypoints.
const CORE_TITLES = {
  [DOMAIN.BUILD]: [
    "Omgevingswet",
    "Besluit bouwwerken leefomgeving",
    "Omgevingsbesluit",
    "Besluit activiteiten leefomgeving",
    "Besluit kwaliteit leefomgeving",
  ],
  [DOMAIN.LOCAL_PUBLIC]: [
    // local framework; actual municipal docs come from CVDR once municipality known
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

// Minimal heuristics ONLY to pick the correct legal framework.
function decideDomain(q) {
  const t = normalize(q);
  const buildSignals = [
    "dakkapel", "uitbouw", "aanbouw", "bouw", "bouwen", "bouwwerk", "verbouwen",
    "omgevingsvergunning", "vergunningvrij", "bopa", "omgevingsplan", "bouwactiviteit",
    "dakopbouw", "bijgebouw", "schuur", "carport", "erker", "gevel", "monument", "welstand",
  ];
  const localSignals = [
    "apv", "algemene plaatselijke verordening", "evenement", "festival", "markt", "braderie",
    "kermis", "terras", "horeca", "sluitingstijd", "sluitingstijden", "alcohol", "bar", "café", "cafe",
    "openbare ruimte", "openbaar terrein", "standplaats",
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

// Best-effort municipality extraction (only used to enable CVDR)
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

// --------------------- SRU search ---------------------
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

// --------------------- ranking (generic, but with strong anti-tax noise) ---------------------
const TAX_NOISE = [
  "inkomstenbelasting", "kapitaalverzekering", "spaarrekening", "beleggingsrecht", "box 3",
  "overgangstermijn", "kew", "eigen woning", // this phrase causes the exact bug you hit
];

function scoreSource(src, domain) {
  const t = normalize(src.title);
  let score = 0;

  if (src.type === "BWB") score += 3;
  if (src.type === "CVDR") score += 2;

  // Strong penalty for known noise classes that break “woning + vergunning”
  for (const w of TAX_NOISE) {
    if (t.includes(w)) score -= 50;
  }

  // Boost framework titles (stelsel)
  for (const core of (CORE_TITLES[domain] || [])) {
    const c = normalize(core);
    if (c && t.includes(c)) score += 80;
  }

  // Mild boosts for likely relevant structures
  if (t.includes("omgevingswet")) score += 20;
  if (t.includes("besluit bouwwerken leefomgeving") || t.includes("bbl")) score += 18;
  if (t.includes("omgevingsbesluit")) score += 16;
  if (t.includes("algemene plaatselijke verordening") || t.includes("apv")) score += 18;
  if (t.includes("verordening")) score += 6;
  if (t.includes("evenement")) score += 6;

  return score;
}

// --------------------- excerpts ---------------------
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

function buildExcerpt(text, terms, maxChars = 2400) {
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
    const resp = await fetchWithTimeout(src.link, { headers: { Range: "bytes=0-600000" } }, 15000);
    const html = await resp.text();
    const cut = html.length > 1_100_000 ? html.slice(0, 1_100_000) : html;
    const text = htmlToTextLite(cut);
    const excerpt = buildExcerpt(text, terms, 2400);
    const value = excerpt || "";
    excerptCache.set(cacheKey, { value, expiresAt: nowMs() + EXCERPT_TTL_MS });
    return value;
  } catch {
    excerptCache.set(cacheKey, { value: "", expiresAt: nowMs() + 15 * 60 * 1000 });
    return "";
  }
}

// --------------------- OpenAI ---------------------
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

// --------------------- build CQL ---------------------
function bwbCqlFromTerms(terms) {
  const t = (terms || []).slice(0, 8).map(x => (x || "").replaceAll('"', "").trim()).filter(Boolean);
  if (!t.length) return `overheidbwb.titel any "Omgevingswet"`;
  const clauses = t.map(x => `overheidbwb.titel any "${x}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function cvdrCql({ municipality, wantApv }) {
  const mun = (municipality || "").replaceAll('"', "").trim();
  const creatorClause = `(dcterms.creator="${mun}" OR dcterms.creator="Gemeente ${mun}")`;

  // Keep local search broad, not topic-hardcoded:
  // APV + verordening + beleidsregel are the typical entry points.
  const inner = wantApv
    ? `(title any "Algemene plaatselijke verordening" OR title any "APV" OR title any "verordening" OR title any "beleidsregel" OR keyword="evenement" OR keyword="terras")`
    : `(title any "verordening" OR title any "beleidsregel" OR title any "Algemene plaatselijke verordening" OR title any "APV")`;

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

  const domain = decideDomain(message);
  const municipality = extractMunicipality(message);

  // 1) Build search terms: user terms + stelsel core titles (forced)
  const userTerms = extractTerms(message, 10);
  const coreTerms = (CORE_TITLES[domain] || []).map(t => normalize(t));
  const terms = uniqBy([...userTerms, ...coreTerms], x => normalize(x)).slice(0, 12);

  // 2) BWB search (broad but anchored by stelsel)
  let bwbResults = [];
  try {
    const xml = await sruSearch({
      endpoint: SRU_BWB_ENDPOINT,
      connection: "BWB",
      cql: bwbCqlFromTerms(terms),
      fetchWithTimeout,
      maximumRecords: SRU_MAX_RECORDS,
    });
    bwbResults = parseSruRecords(xml, "BWB");
  } catch { bwbResults = []; }

  // 3) Also fetch core documents explicitly (by title) to guarantee correct framework in sources
  // We do this by additional SRU queries per core title, then merge. (No guessing IDs.)
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
      // Prefer the most exact title match
      const exact = recs.find(r => normalize(r.title) === normalize(ct));
      if (exact) coreDocs.push(exact);
      else if (recs[0]) coreDocs.push(recs[0]);
    } catch {}
  }

  // 4) CVDR search if municipality known and local domain likely
  let cvdrResults = [];
  if (municipality && (domain === DOMAIN.LOCAL_PUBLIC || domain === DOMAIN.BUILD)) {
    try {
      const xml = await sruSearch({
        endpoint: SRU_CVDR_ENDPOINT,
        connection: "cvdr",
        cql: cvdrCql({ municipality, wantApv: domain === DOMAIN.LOCAL_PUBLIC }),
        fetchWithTimeout,
        maximumRecords: SRU_MAX_RECORDS,
      });
      cvdrResults = parseSruRecords(xml, "CVDR");
    } catch { cvdrResults = []; }
  }

  // 5) Merge candidates + rank
  let candidates = uniqBy([...coreDocs, ...bwbResults, ...cvdrResults], x => `${x.type}:${x.id}`);
  candidates = candidates
    .map(s => ({ ...s, _score: scoreSource(s, domain) }))
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, MAX_CANDIDATES);

  // 6) Fetch excerpts from top N
  const excerptTerms = uniqBy(
    [
      ...userTerms,
      ...((CORE_TITLES[domain] || []).map(t => normalize(t))),
      municipality ? normalize(municipality) : "",
      // helpful generic words that often occur in relevant passages
      "vergunning", "vergunningsvrij", "omgevingsvergunning", "meldingsplicht", "toestemming", "aanvraag",
    ],
    x => normalize(x)
  ).filter(Boolean).slice(0, 18);

  const toFetch = candidates.slice(0, EXCERPTS_FETCH);
  const sourcesWithEx = [];
  for (const src of toFetch) {
    const excerpt = await fetchExcerpt({ src, terms: excerptTerms, fetchWithTimeout });
    sourcesWithEx.push({ ...src, excerpt: (excerpt || "").trim() });
  }

  // Ensure we only show unique sources and keep ordering
  const usedSources = uniqBy(sourcesWithEx, x => `${x.type}:${x.id}`).slice(0, UI_SOURCES_MAX);

  // 7) Ask OpenAI to answer ONLY from excerpts + cite [n]
  const systemPrompt = `
Je bent Beleidsbank (NL wet- en regelgeving + beleid).
Je krijgt officiële bronnen [1..N] met korte uittreksels (excerpts).

REGELS (hard):
- Beantwoord op basis van de excerpts. Gebruik [n] alleen als de claim steun vindt in excerpt [n].
- Als je het niet kunt onderbouwen uit excerpts: zeg dat expliciet en verwijs naar de meest relevante bron(nen) om na te lezen.
- Verzin geen artikelnummers/lidnummers tenzij ze letterlijk in excerpt staan.
- Geen meta-tekst ("als AI", trainingsdata, etc.).
- Noem Wabo alleen als de gebruiker er expliciet naar vraagt of als het letterlijk in excerpt staat.

STIJL:
- Kort, praktisch, voorzichtig. 1–2 alinea’s + eventueel 3 bullets met wat te checken.
`.trim();

  const userPayload = {
    question: message,
    domain,
    municipality,
    sources: usedSources.map((s, i) => ({
      n: i + 1,
      id: s.id,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt || "",
    })),
  };

  const ai = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 900,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  let answer = "";
  if (ai.ok) {
    answer = sanitizeInlineCitations(stripModelLeakage(ai.content), usedSources.length);
  } else {
    answer =
      "Ik kon op dit moment geen antwoord genereren op basis van de opgehaalde uittreksels. " +
      "Bekijk de onderstaande bronnen om de relevante bepalingen te vinden.";
    if ((domain === DOMAIN.LOCAL_PUBLIC || domain === DOMAIN.BUILD) && !municipality) {
      answer += " Let op: lokale regels kunnen per gemeente verschillen. Noem de gemeente voor lokale regelgeving.";
    }
  }

  // 8) Output
  return res.status(200).json({
    answer,
    sources: usedSources.map((s, i) => ({
      n: i + 1,
      id: s.id,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt || "",
    })),
  });
}
