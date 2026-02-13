// /api/chat.js — Beleidsbank V1 (Stelsel-routing + artikelblokken-extractor)
// Next.js API route (Node runtime).
//
// Doel:
// - Voorkomt SRU-ruis (zoals "eigen woning" → belasting) via minimale stelsel-routing.
// - Haalt daarna officiële bronnen op (BWB + CVDR), leest pagina’s uit,
//   en probeert expliciet ARTIKELBLOKKEN te pakken i.p.v. losse regels.
// - AI antwoordt alleen op basis van excerpts en citeert met [n] (bronnummer).
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

const EXCERPTS_FETCH = 8;  // hoeveel docs we echt uitlezen (stabiel V1)
const UI_SOURCES_MAX = 10; // hoeveel sources terug naar UI

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

// --------------------- minimal stelsel routing ---------------------
const DOMAIN = {
  BUILD: "build",
  LOCAL_PUBLIC: "local_public",
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

function extractMunicipality(message) {
  const text = (message || "").toString();

  let m = text.match(/\bgemeente\s+([A-Za-zÀ-ÿ'\-]+(?:\s+[A-Za-zÀ-ÿ'\-]+){0,3})/i);
  if (m?.[1]) return titleCase(m[1]);

  m = text.match(/\b(?:in|te|bij)\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+){0,3})/);
  if (m?.[1]) return titleCase(m[1]);

  return null;
}

// --------------------- terms ---------------------
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

  return uniqBy(out, x => `${x.type}:${x.id}`);
}

// --------------------- ranking (anti-tax noise + stelsel boost) ---------------------
const TAX_NOISE = [
  "inkomstenbelasting", "kapitaalverzekering", "spaarrekening", "beleggingsrecht", "box 3",
  "overgangstermijn", "kew", "eigen woning",
];

function scoreSource(src, domain) {
  const t = normalize(src.title);
  let score = 0;

  if (src.type === "BWB") score += 3;
  if (src.type === "CVDR") score += 2;

  for (const w of TAX_NOISE) if (t.includes(w)) score -= 60;

  for (const core of (CORE_TITLES[domain] || [])) {
    const c = normalize(core);
    if (c && t.includes(c)) score += 90;
  }

  if (t.includes("omgevingswet")) score += 25;
  if (t.includes("besluit bouwwerken leefomgeving") || t.includes("bbl")) score += 20;
  if (t.includes("omgevingsbesluit")) score += 18;
  if (t.includes("algemene plaatselijke verordening") || t.includes("apv")) score += 22;
  if (t.includes("verordening")) score += 8;
  if (t.includes("evenement")) score += 8;
  if (t.includes("terras")) score += 6;

  return score;
}

// --------------------- excerpt extraction (ARTIKELBLOKKEN) ---------------------
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
  // Split into blocks that start with "Artikel ..." (or "Art. ...")
  // Works “best-effort” across wetten.overheid.nl and lokaleregelgeving pages.
  const clean = (text || "").replace(/\u00a0/g, " ").trim();
  if (!clean) return [];

  const re = /(^|\n)(Artikel|Art\.)\s+([0-9]+[0-9A-Za-z:.\-]*)([^\n]*)/gmi;
  const matches = [...clean.matchAll(re)];
  if (matches.length < 2) return []; // not enough to chunk reliably

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
  // prefer blocks that mention vergunning/verbod/toestemming/tijden etc
  const legalSignals = ["vergunning", "vergunningsvrij", "toestemming", "verboden", "verbod", "ontheffing", "sluiting", "tijd", "tijden", "opening"];
  for (const sig of legalSignals) if (b.includes(sig)) s += 1;
  return s;
}

function pickBestArticleBlocks(text, keywords, maxChars = 2600) {
  const blocks = chunkByArticles(text);
  if (!blocks.length) return "";

  const scored = blocks
    .map(bl => ({ bl, s: scoreBlock(bl, keywords) }))
    .sort((a, b) => b.s - a.s);

  // take top 2–3 blocks until maxChars
  const out = [];
  let used = 0;
  for (const it of scored.slice(0, 6)) {
    if (it.s <= 0) continue;
    const add = it.bl.trim();
    if (!add) continue;
    if (used + add.length + 8 > maxChars) continue;
    out.push(add);
    used += add.length + 2;
    if (out.length >= 3) break;
  }

  if (!out.length) {
    // fallback: first 1–2 blocks (still better than random lines)
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
    const resp = await fetchWithTimeout(src.link, { headers: { Range: "bytes=0-800000" } }, 15000);
    const html = await resp.text();
    const cut = html.length > 1_200_000 ? html.slice(0, 1_200_000) : html;
    const text = htmlToTextLite(cut);

    // Prefer article blocks if possible:
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

// --------------------- CQL builders ---------------------
function bwbCqlFromTerms(terms) {
  const t = (terms || []).slice(0, 8).map(x => (x || "").replaceAll('"', "").trim()).filter(Boolean);
  if (!t.length) return `overheidbwb.titel any "Omgevingswet"`;
  const clauses = t.map(x => `overheidbwb.titel any "${x}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function cvdrCql({ municipality, wantApv }) {
  const mun = (municipality || "").replaceAll('"', "").trim();
  const creatorClause = `(dcterms.creator="${mun}" OR dcterms.creator="Gemeente ${mun}")`;

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

  // 1) Terms: user terms + stelsel core titles
  const userTerms = extractTerms(message, 10);
  const coreTerms = (CORE_TITLES[domain] || []).map(t => normalize(t));
  const terms = uniqBy([...userTerms, ...coreTerms], x => normalize(x)).slice(0, 12);

  // 2) BWB search (anchored by stelsel)
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

  // 3) Fetch core docs explicitly (guarantee correct framework)
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

  // 4) CVDR if municipality known and likely local domain
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

  // 5) Merge + rank
  let candidates = uniqBy([...coreDocs, ...bwbResults, ...cvdrResults], x => `${x.type}:${x.id}`);
  candidates = candidates
    .map(s => ({ ...s, _score: scoreSource(s, domain) }))
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, MAX_CANDIDATES);

  // 6) Excerpt terms (artikelblokken zoeken)
  const excerptTerms = uniqBy(
    [
      ...userTerms,
      ...((CORE_TITLES[domain] || []).map(t => normalize(t))),
      municipality ? normalize(municipality) : "",
      "vergunning","vergunningsvrij","omgevingsvergunning","toestemming","verbod","ontheffing","sluiting","opening","tijden",
      "evenement","terras","horeca",
    ],
    x => normalize(x)
  ).filter(Boolean).slice(0, 20);

  const toFetch = candidates.slice(0, EXCERPTS_FETCH);
  const sourcesWithEx = [];
  for (const src of toFetch) {
    const excerpt = await fetchExcerpt({ src, terms: excerptTerms, fetchWithTimeout });
    sourcesWithEx.push({ ...src, excerpt: (excerpt || "").trim() });
  }

  const usedSources = uniqBy(sourcesWithEx, x => `${x.type}:${x.id}`).slice(0, UI_SOURCES_MAX);

  // 7) Answer with citations
  const systemPrompt = `
Je bent Beleidsbank (NL wet- en regelgeving + beleid).
Je krijgt officiële bronnen [1..N] met uittreksels (excerpts).

REGELS (hard):
- Beantwoord op basis van de excerpts. Gebruik [n] alleen als de claim steun vindt in excerpt [n].
- Als iets niet uit excerpts blijkt: zeg dat, en verwijs naar de meest relevante bron(nen) om na te lezen.
- Verzin geen artikelnummers/lidnummers tenzij ze letterlijk in excerpt staan.
- Geen meta-tekst ("als AI", trainingsdata, etc.).

STIJL:
- Kort, praktisch, juristvriendelijk.
- Eerst 2–6 zinnen antwoord. Daarna 2–4 bullets “Wat te checken”.
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
