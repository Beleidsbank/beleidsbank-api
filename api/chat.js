// /api/chat.js — Beleidsbank V1 (FIXED: juiste bronnen, stabiele nummers, minder ruis, beter voor “evenement” vs “betoging”)
// Next.js API route (Node runtime)
//
// Fixes t.o.v. jouw laatste output:
// 1) Bronnummering is nu 100% stabiel: sources[] bevat altijd n=1..N, uniek per bron (geen duplicaten).
// 2) AI móét citeren met [n] (en als hij een bron noemt, móét er een nummer bij).
// 3) “Evenement” ≠ “betoging”: WOM alleen als het duidelijk om betoging/demonstratie gaat.
// 4) We sturen géén stapels algemene wetten mee tenzij ze echt relevant zijn (anders wordt AI vaag).
// 5) We selecteren eerst top-bronnen met AI, daarna antwoorden we alleen met die bronnen.
//
// Input:  { session_id?: string, message: string }
// Output: { answer: string, sources: [{n,id,title,link,type,excerpt}] }

const SRU_BWB_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search"; // x-connection=BWB
const SRU_CVDR_ENDPOINT = "https://zoekdienst.overheid.nl/sru/Search"; // x-connection=cvdr
const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_MESSAGE_CHARS = 2000;

// Retrieval tuning (V1: snel maar bruikbaar)
const SRU_MAX_RECORDS = 50;
const MAX_CANDIDATES = 60;
const EXCERPTS_FETCH = 14;
const UI_SOURCES_MAX = 8;

const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;

const rateStore = new Map();
const excerptCache = new Map();

// --------------------- utils ---------------------
function nowMs() {
  return Date.now();
}
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
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
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
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#([0-9]+);/g, (_, num) => {
      try {
        return String.fromCodePoint(parseInt(num, 10));
      } catch {
        return "";
      }
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

// --------------------- stelsel routing ---------------------
const DOMAIN = {
  BUILD: "build",
  LOCAL: "local",
  GENERAL: "general",
};

function decideDomain(q) {
  const t = normalize(q);

  const buildSignals = [
    "dakkapel",
    "uitbouw",
    "aanbouw",
    "bouw",
    "bouwen",
    "bouwwerk",
    "verbouwen",
    "omgevingsvergunning",
    "vergunningvrij",
    "bopa",
    "omgevingsplan",
    "bouwactiviteit",
    "dakopbouw",
    "bijgebouw",
    "welstand",
    "monument",
  ];

  const localSignals = [
    "apv",
    "algemene plaatselijke verordening",
    "evenement",
    "festival",
    "markt",
    "braderie",
    "kermis",
    "terras",
    "horeca",
    "sluitingstijd",
    "sluitingstijden",
    "openbaar terrein",
    "openbare ruimte",
    "standplaats",
  ];

  if (buildSignals.some((w) => t.includes(w))) return DOMAIN.BUILD;
  if (localSignals.some((w) => t.includes(w))) return DOMAIN.LOCAL;
  return DOMAIN.GENERAL;
}

function titleCase(s) {
  return (s || "")
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
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

// “Evenement” vs “betoging/demonstratie”
function looksLikeDemonstration(message) {
  const t = normalize(message);
  return ["betoging", "demonstratie", "manifestatie", "protest", "mars", "optocht", "bijeenkomst"].some((w) => t.includes(w));
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

  const tokens = raw.split(" ").map((t) => normalize(t)).filter(Boolean);
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

  return uniqBy(out, (x) => `${x.type}:${x.id}`);
}

// --------------------- ranking / anti-ruis ---------------------
const TAX_NOISE = [
  "inkomstenbelasting",
  "kapitaalverzekering",
  "spaarrekening",
  "beleggingsrecht",
  "box 3",
  "overgangstermijn",
  "kew",
  "eigen woning",
];

// Belangrijk: we sturen niet alles “core” mee, alleen de écht juiste entry points per domein.
const CORE_QUERY_TITLES = {
  [DOMAIN.BUILD]: ["Omgevingswet", "Besluit bouwwerken leefomgeving", "Omgevingsbesluit"],
  [DOMAIN.LOCAL]: ["Algemene plaatselijke verordening", "APV"], // lokale entry point
  [DOMAIN.GENERAL]: ["Algemene wet bestuursrecht"],
};

function scoreSource(src, domain, message) {
  const t = normalize(src.title);
  let score = 0;
  score += src.type === "CVDR" ? 6 : 3; // bij lokale vragen is CVDR vaak belangrijker

  for (const w of TAX_NOISE) if (t.includes(w)) score -= 100;

  // Domein-boost
  if (domain === DOMAIN.LOCAL) {
    if (t.includes("algemene plaatselijke verordening") || t === "apv" || t.includes(" apv")) score += 120;
    if (t.includes("evenement")) score += 18;
    if (t.includes("terras")) score += 18;
    // WOM alleen als betoging/demonstratie
    if (t.includes("wet openbare manifestaties")) score += looksLikeDemonstration(message) ? 40 : -40;
    if (t.includes("gemeentewet") || t.includes("algemene wet bestuursrecht")) score -= 15; // meestal niet “het antwoord”
  }

  if (domain === DOMAIN.BUILD) {
    if (t.includes("omgevingswet")) score += 120;
    if (t.includes("besluit bouwwerken leefomgeving") || t.includes("bbl")) score += 110;
    if (t.includes("omgevingsbesluit")) score += 90;
  }

  return score;
}

// --------------------- excerpt extraction (artikelblokken) ---------------------
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

  // APV’s gebruiken vaak “Artikel 2:24” etc.
  const re = /(^|\n)(Artikel|Art\.)\s+([0-9]+(?::[0-9]+)?[0-9A-Za-z.\-]*)([^\n]*)/gmi;
  const matches = [...clean.matchAll(re)];
  if (matches.length < 2) return [];

  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + (matches[i][1] ? matches[i][1].length : 0);
    const end = i + 1 < matches.length ? matches[i + 1].index : clean.length;
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
  const legalSignals = ["vergunning","melding","toestemming","verbod","ontheffing","sluiting","opening","tijden","tijdstip","maximaal","verboden"];
  for (const sig of legalSignals) if (b.includes(sig)) s += 1;
  return s;
}

function pickBestArticleBlocks(text, keywords, maxChars = 2600) {
  const blocks = chunkByArticles(text);
  if (!blocks.length) return "";

  const scored = blocks
    .map((bl) => ({ bl, s: scoreBlock(bl, keywords) }))
    .sort((a, b) => b.s - a.s);

  const out = [];
  let used = 0;

  for (const it of scored.slice(0, 10)) {
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
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";

  const keys = uniqBy((terms || []).map(normalize), (x) => x).filter((x) => x && x.length >= 3);
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

  const ordered = [...idx].sort((a, b) => a - b).map((i) => lines[i]);
  let out = ordered.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

async function fetchExcerpt({ src, terms, fetchWithTimeout }) {
  const cacheKey = `ex:${src.type}:${src.id}:${terms.map(normalize).join("|").slice(0, 160)}`;
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

// --------------------- CQL ---------------------
function bwbCqlFromTerms(terms) {
  const t = (terms || []).slice(0, 10).map((x) => (x || "").replaceAll('"', "").trim()).filter(Boolean);
  if (!t.length) return `overheidbwb.titel any "Algemene wet bestuursrecht"`;
  const clauses = t.map((x) => `overheidbwb.titel any "${x}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

// CVDR: als gemeente bekend → zoek breed naar APV/verordening/beleidsregel, en laat excerpt extractor het juiste artikel pakken
function cvdrCql({ municipality }) {
  const mun = (municipality || "").replaceAll('"', "").trim();
  const creatorClause = `(dcterms.creator="${mun}" OR dcterms.creator="Gemeente ${mun}")`;
  const inner = `(title any "Algemene plaatselijke verordening" OR title any "APV" OR title any "verordening" OR title any "beleidsregel")`;
  return `(${creatorClause} AND ${inner})`;
}

// --------------------- AI selector (top bronnen kiezen) ---------------------
async function pickBestSourcesWithAI({ apiKey, fetchWithTimeout, question, domain, municipality, sources }) {
  const system = `
Je bent een juridische retrieval-assistent.
Kies de 2 tot 4 BESTE bronnen om de vraag te beantwoorden.

Heel belangrijk:
- Een “evenement” (vergunning/melding, APV evenementen) is NIET automatisch een “betoging/demonstratie”.
- Gebruik Wet openbare manifestaties alleen als de vraag duidelijk over betoging/demonstratie/protest/optocht gaat.
- Kies bronnen met concreet artikel/tekst (sluitingstijden, vergunningplicht, procedure), niet alleen algemene kaders.

Output: ALLEEN JSON exact:
{"pick":[1,2],"need_municipality":false}
`.trim();

  const payload = {
    question,
    domain,
    municipality,
    sources: sources.map((s) => ({
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
    max_tokens: 250,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  if (!ai.ok) return { pick: sources.slice(0, 3).map((s) => s.n), need_municipality: false };

  const parsed = safeJsonParse(ai.content);
  if (!parsed || !Array.isArray(parsed.pick)) return { pick: sources.slice(0, 3).map((s) => s.n), need_municipality: false };

  const pick = parsed.pick
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= sources.length);

  const uniqPick = [...new Set(pick)].slice(0, 4);
  if (!uniqPick.length) return { pick: sources.slice(0, 3).map((s) => s.n), need_municipality: false };

  return { pick: uniqPick, need_municipality: !!parsed.need_municipality };
}

// --------------------- FINAL ANSWER prompt ---------------------
function buildAnswerSystemPrompt() {
  return `
Je bent Beleidsbank, een assistent voor Nederlandse wet- en regelgeving en beleid.

Je krijgt:
- een VRAAG
- BRONNEN [1..N] met UITTREKSELS

Harde regels:
- CITEER ALTIJD MET [n] als je een bron gebruikt. Geen “(bron )” zonder nummer.
- Gebruik [n] alleen als de claim echt steun heeft in het excerpt van [n].
- Als excerpt het detail niet bevat: zeg dat en verwijs naar de bron om zelf na te lezen.
- Verzin geen artikelnummers/lidnummers tenzij letterlijk aanwezig in excerpt.
- Geen meta-tekst (“als AI”, trainingsdata, etc.).

Stijl:
- 1 korte alinea antwoord.
- Daarna “Wat te checken:” met 2–4 bullets.
`.trim();
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

  // Search terms
  const userTerms = extractTerms(message, 10);

  // Core query titles per domain (klein houden → minder ruis)
  const coreTerms = (CORE_QUERY_TITLES[domain] || []).map((t) => normalize(t));
  const searchTerms = uniqBy([...userTerms, ...coreTerms], (x) => normalize(x)).slice(0, 12);

  // 1) BWB search
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
  } catch {
    bwbResults = [];
  }

  // 2) CVDR search (als gemeente bekend)
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
    } catch {
      cvdrResults = [];
    }
  }

  // 3) merge + rank
  let candidates = uniqBy([...cvdrResults, ...bwbResults], (x) => `${x.type}:${x.id}`);
  candidates = candidates
    .map((s) => ({ ...s, _score: scoreSource(s, domain, message) }))
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, MAX_CANDIDATES);

  // 4) excerpt terms (extra signalwoorden)
  const excerptTerms = uniqBy(
    [
      ...userTerms,
      municipality ? normalize(municipality) : "",
      "vergunning",
      "evenement",
      "evenementenvergunning",
      "melding",
      "kennisgeving",
      "toestemming",
      "ontheffing",
      "sluiting",
      "opening",
      "tijden",
      "terras",
      "horeca",
      "openbare orde",
      "veiligheid",
      looksLikeDemonstration(message) ? "betoging" : "",
      looksLikeDemonstration(message) ? "demonstratie" : "",
    ],
    (x) => normalize(x)
  ).filter(Boolean).slice(0, 18);

  // 5) fetch excerpts
  const toFetch = candidates.slice(0, EXCERPTS_FETCH);
  const fetched = [];
  for (const src of toFetch) {
    const excerpt = await fetchExcerpt({ src, terms: excerptTerms, fetchWithTimeout });
    fetched.push({ ...src, excerpt: (excerpt || "").trim() });
  }

  // 6) hard dedupe + number sources 1..N (STABIEL!)
  const deduped = uniqBy(
    fetched.filter((s) => s.excerpt && s.excerpt.trim().length > 50),
    (s) => `${s.type}:${s.id}` // uniek per document
  );

  const topForUI = deduped.slice(0, UI_SOURCES_MAX).map((s, idx) => ({
    n: idx + 1,
    id: s.id,
    title: s.title,
    link: s.link,
    type: s.type,
    excerpt: s.excerpt,
  }));

  // fallback: als excerpt faalt, toch iets teruggeven
  if (!topForUI.length) {
    const fallbackSources = uniqBy(fetched, (s) => `${s.type}:${s.id}`).slice(0, UI_SOURCES_MAX).map((s, idx) => ({
      n: idx + 1,
      id: s.id,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt || "",
    }));

    return res.status(200).json({
      answer:
        "Ik kon geen bruikbare uittreksels ophalen uit de officiële bronnen. Bekijk de bronnen hieronder en probeer de vraag iets specifieker te maken (bij lokale regels: noem de gemeente).",
      sources: fallbackSources,
    });
  }

  // 7) AI kiest 2–4 beste bronnen
  const selection = await pickBestSourcesWithAI({
    apiKey,
    fetchWithTimeout,
    question: message,
    domain,
    municipality,
    sources: topForUI,
  });

  const pickedSet = new Set(selection.pick);
  const picked = topForUI.filter((s) => pickedSet.has(s.n));
  const pickedSources = picked.length ? picked : topForUI.slice(0, 3);

  // 8) Final answer on picked sources
  const userPayload = {
    question: message,
    municipality: municipality || null,
    domain,
    sources: pickedSources.map((s) => ({
      n: s.n,
      id: s.id,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt,
    })),
    note:
      domain === DOMAIN.LOCAL && !municipality
        ? "Lokale regels verschillen per gemeente. Noem de gemeente voor exacte APV/beleid."
        : null,
  };

  const ai = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 800,
    temperature: 0.2,
    messages: [
      { role: "system", content: buildAnswerSystemPrompt() },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  let answer = "";
  if (ai.ok) {
    answer = stripModelLeakage(ai.content);
    answer = sanitizeInlineCitations(answer, pickedSources.length);
    // Extra guard: verwijder “(bron )” zonder nummer
    answer = answer.replace(/\(bron\s*\)/gi, "").replace(/bron\s*\)/gi, ")").trim();
  } else {
    answer =
      "Ik kon op dit moment geen antwoord genereren op basis van de opgehaalde uittreksels. Bekijk de onderstaande bronnen om de relevante bepalingen te vinden.";
  }

  // 9) Return sources: picked eerst (voor UX), maar nummering blijft hetzelfde (n blijft 1..N van topForUI)
  const orderedSources = [
    ...pickedSources,
    ...topForUI.filter((s) => !pickedSources.some((p) => p.n === s.n)),
  ];

  return res.status(200).json({
    answer,
    sources: orderedSources,
  });
}
