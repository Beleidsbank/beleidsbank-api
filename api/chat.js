// /api/chat.js
// Beleidsbank - “ultimate” single-file API route:
// ✅ Works with Safari preflight (CORS/OPTIONS first)
// ✅ Rate limiting
// ✅ Slot-followup (gemeente + enkele contextvragen) zonder loop
// ✅ Scope-detectie: juridische grondslag/“welke bepaling” => LANDelijk (BWB), niet per ongeluk gemeentelijk
// ✅ Gemeentelijke bronranking + blacklist (darkstore/flitsbezorging e.d.) om ruis omlaag/weg te duwen
// ✅ Landelijk: forceer Omgevingswet bij omgevingsplan/vergunningplicht/grondslagvragen
// ✅ Norm-extractie: haalt gericht normtekst uit Omgevingswet (Artikel 5.1-sectie) en dwingt bewijsquote af
// ✅ Post-validatie: als model geen normquote levert -> server-fallback met normquote of “niet zichtbaar”
// ✅ Wabo hard geblokkeerd (titel + bekende IDs)

const rateStore = new Map();
const pendingStore = new Map();
// sessionId -> { originalQuestion, missingSlots:[], collected:{}, createdAt, attempts }

const MAX_SOURCES_RETURN = 4;

// ---------------------------
// Helpers
// ---------------------------
function nowMs() { return Date.now(); }

function rateLimit(ip, limit = 12, windowMs = 60000) {
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

function normalize(s) {
  return (s || "").toLowerCase().trim();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function looksLikeMunicipality(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.length > 40) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;
  return /^[\p{L}\s.'-]+$/u.test(t);
}

function hasMeaningfulDetail(s) {
  const t = (s || "").trim();
  if (!t) return false;
  if (t.length < 3) return false;
  const lc = normalize(t);
  const badExact = new Set([
    "?", "??", "???", "geen idee", "weet ik niet", "idk", "geen", "nvt", "organisatie?", "context", "help"
  ]);
  if (badExact.has(lc)) return false;
  if (lc.includes("geen idee") || lc.includes("weet ik niet")) return false;
  return true;
}

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

function stripSourcesFromAnswer(answer) {
  const a = (answer || "").trim();
  if (!a) return a;
  const low = a.toLowerCase();
  const idx = low.indexOf("\nbronnen:");
  if (idx !== -1) return a.slice(0, idx).trim();
  const idx2 = low.indexOf("bronnen:");
  if (idx2 !== -1 && (idx2 === 0 || a[idx2 - 1] === "\n")) return a.slice(0, idx2).trim();
  return a;
}

function pickAll(text, re) {
  return [...text.matchAll(re)].map(m => m[1]);
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

// ---------------------------
// Hard bans
// ---------------------------
const BANNED_BWBR_IDS = new Set([
  "BWBR0024779", // Wabo (official)
  "BWBR0047270"  // seen earlier in outputs
]);

function isBannedSource(item) {
  const id = (item?.id || "").toString().trim().toUpperCase();
  const title = normalize(item?.title || "");
  if (id && BANNED_BWBR_IDS.has(id)) return true;

  // Strong textual ban
  if (title.includes("wabo")) return true;
  if (title.includes("wet algemene bepalingen omgevingsrecht")) return true;
  if (title.includes("algemene bepalingen omgevingsrecht")) return true;

  return false;
}

function removeBanned(items) {
  return (items || []).filter(x => !isBannedSource(x));
}

// ---------------------------
// Follow-up slots (minimal & non-annoying)
// ---------------------------
const ALLOWED_SLOTS = ["municipality", "location_hint", "activity_hint", "topic_hint"];

function questionForSlot(slot) {
  if (slot === "municipality") return "Voor welke gemeente geldt dit?";
  if (slot === "location_hint") return "Gaat het om een specifieke locatie/gebied? (bv. straat/wijk, of ‘eigen terrein’ / ‘openbare ruimte’)";
  if (slot === "activity_hint") return "Wat is de activiteit/context? (bv. horeca, bouw, evenement, handhaving, parkeren, subsidie)";
  if (slot === "topic_hint") return "Waar gaat uw vraag precies over? (bv. bouwen, milieu, handhaving, subsidies, onderwijs, verkeer)";
  return "Kunt u dit iets specifieker maken?";
}

function askForMissing(missingSlots) {
  const slots = (missingSlots || []).filter(Boolean);
  if (!slots.length) return null;
  if (slots.length === 1) return questionForSlot(slots[0]);
  const two = slots.slice(0, 2).map(questionForSlot);
  return `Ik heb nog ${two.length} korte vragen:\n- ${two.join("\n- ")}`;
}

// ---------------------------
// Scope detection (key to your problem)
// ---------------------------
function isLegalBasisQuestion(qLc) {
  return (
    qLc.includes("op grond van welke") ||
    qLc.includes("welke bepaling") ||
    qLc.includes("welk artikel") ||
    qLc.includes("juridische grondslag") ||
    qLc.includes("bevoegdheid") ||
    qLc.includes("grondslag") ||
    qLc.includes("vergunningplicht") ||
    (qLc.includes("vereist") && (qLc.includes("omgevingsvergunning") || qLc.includes("vergunning"))) ||
    (qLc.includes("is") && qLc.includes("vergunning") && qLc.includes("nodig"))
  );
}

function isExplicitMunicipalTopic(qLc) {
  // Municipal-only topics where gemeente is essential
  return (
    qLc.includes("apv") ||
    qLc.includes("algemene plaatselijke verordening") ||
    qLc.includes("terras") ||
    qLc.includes("terrassen") ||
    qLc.includes("standplaats") ||
    qLc.includes("evenementenvergunning") ||
    qLc.includes("parkeervergunning") ||
    qLc.includes("blauwe zone") ||
    qLc.includes("sluitingstijden") ||
    qLc.includes("huisvuil") ||
    qLc.includes("afvalstoffenverordening") ||
    qLc.includes("marktverordening") ||
    qLc.includes("bomenverordening") ||
    qLc.includes("ligplaats") ||
    qLc.includes("havenverordening") ||
    (qLc.includes("gemeentelijke") && (qLc.includes("verordening") || qLc.includes("beleidsregel")))
  );
}

function isOmgevingsplanLocalInterpretationQuestion(qLc) {
  // Only municipal if user asks "wat staat er in het omgevingsplan" for a place/area
  return (
    (qLc.includes("wat staat er in") && qLc.includes("omgevingsplan")) ||
    (qLc.includes("regels") && qLc.includes("omgevingsplan") && (qLc.includes("adres") || qLc.includes("locatie") || qLc.includes("perceel") || qLc.includes("gebied"))) ||
    (qLc.includes("omgevingsplan") && qLc.includes("van de gemeente") && !isLegalBasisQuestion(qLc))
  );
}

function decideScope(q) {
  const qLc = normalize(q);

  // Groundslag/vergunningplicht => NATIONAL (even if a municipality is mentioned)
  if (isLegalBasisQuestion(qLc)) return "national";

  // Clearly municipal domains
  if (isExplicitMunicipalTopic(qLc)) return "municipal";

  // Omgevingsplan is municipal only if it's asking plan content for a place
  if (isOmgevingsplanLocalInterpretationQuestion(qLc)) return "municipal";

  // Default national (covers most “wet/regeling” questions)
  return "national";
}

// ---------------------------
// Query heuristics (generic, not 10 topics)
// ---------------------------
const NEGATIVE_NOISE_TERMS = [
  // your “darkstore” noise bucket
  "darkstore", "dark stores", "flitsbezorg", "flitsbezorging", "bezorghub", "bezorghub", "bezorgdiensten",
  "rederij", "rederijen", "vaart", "rondvaart", "cruise", "scheepvaart",
  "parkeergarage", "taxi", "taxistandplaats",
  "luchtvaart", "weeze", // seen in your noise
];

function extractQueryTerms(q) {
  const qLc = normalize(q);
  const words = qLc.split(/[^a-z0-9áéíóúàèìòùäëïöüçñ\-]+/i).filter(Boolean);

  // Keep meaningful tokens
  const keep = [];
  for (const w of words) {
    if (w.length < 4) continue;
    if (["voor", "naar", "door", "over", "onder", "tussen", "zodat", "waarom", "welke", "bepaling", "artikel", "grond", "grondslag"].includes(w)) continue;
    keep.push(w);
  }
  return [...new Set(keep)].slice(0, 10);
}

function shouldAskMore(q, scope) {
  // Keep it minimal: only ask if too vague (generic) or municipal needs municipality.
  const words = (q || "").trim().split(/\s+/).filter(Boolean);
  if (scope === "national") {
    return (q || "").trim().length < 18 || words.length <= 3;
  }
  return false;
}

// ---------------------------
// SRU Searches
// ---------------------------
async function cvdrSearch({ municipalityName, topicText, fetchWithTimeout }) {
  const base = "https://zoekdienst.overheid.nl/sru/Search";
  const creatorsToTry = [
    municipalityName,
    `Gemeente ${municipalityName}`,
    `gemeente ${municipalityName}`
  ];

  const safeTopic = (topicText || "").replaceAll('"', "").trim() || "";

  for (const creator of creatorsToTry) {
    // “keyword all” is forgiving enough; keep simple and stable
    const cql = `(dcterms.creator="${creator}") AND (keyword all "${safeTopic}")`;

    const url =
      `${base}?version=1.2` +
      `&operation=searchRetrieve` +
      `&x-connection=cvdr` +
      `&x-info-1-accept=any` +
      `&maximumRecords=25` +
      `&startRecord=1` +
      `&query=${encodeURIComponent(cql)}`;

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

    const uniq = removeBanned(dedupeByLink(items));
    if (uniq.length) return uniq;
  }

  return [];
}

async function oepSearch({ municipalityName, topicText, fetchWithTimeout }) {
  const base = "https://zoek.officielebekendmakingen.nl/sru/Search";
  const safeTopic = (topicText || "").replaceAll('"', "").trim() || "";
  const cql = `publicatieNaam="Gemeenteblad" AND keyword all "${municipalityName} ${safeTopic}"`;

  const url =
    `${base}?version=1.2` +
    `&operation=searchRetrieve` +
    `&x-connection=oep` +
    `&recordSchema=dc` +
    `&maximumRecords=25` +
    `&startRecord=1` +
    `&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url, {}, 15000);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
  const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

  const items = ids.map((id, i) => ({
    id,
    title: titles[i] || id,
    link: `https://zoek.officielebekendmakingen.nl/${id}.html`,
    type: "OEP (Gemeenteblad)"
  }));

  return removeBanned(dedupeByLink(items));
}

const OMGEVINGSWET_ID = "BWBR0037885";

async function bwbSruSearch({ cql, fetchWithTimeout, max = 25 }) {
  const base = "https://zoekservice.overheid.nl/sru/Search";
  const url =
    `${base}?version=1.2&operation=searchRetrieve&x-connection=BWB` +
    `&maximumRecords=${max}&startRecord=1` +
    `&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url, {}, 15000);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
  const titlesA = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);
  const titlesB = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);
  const titles = titlesA.length ? titlesA : titlesB;

  let items = ids.map((id, i) => ({
    id,
    title: titles[i] || id,
    link: `https://wetten.overheid.nl/${id}`,
    type: "BWB"
  }));

  items = removeBanned(dedupeByLink(items));
  return items;
}

async function bwbSearchSmart({ q, fetchWithTimeout, forceOw }) {
  const qLc = normalize(q);
  const terms = extractQueryTerms(q).slice(0, 6);
  const safeQ = (q || "").replaceAll('"', "").trim();

  // 1) For Omgevingswet-stelsel questions, always search core set first
  const looksOmgevingswet =
    forceOw ||
    qLc.includes("omgevingsplan") ||
    qLc.includes("omgevingsvergunning") ||
    qLc.includes("bopa") ||
    qLc.includes("omgevingsplanactiviteit") ||
    qLc.includes("bouwactiviteit") ||
    qLc.includes("tijdelijk afwijken") ||
    qLc.includes("afwijken van het omgevingsplan");

  if (looksOmgevingswet) {
    const core = [
      `overheidbwb.titel any "Omgevingswet"`,
      `overheidbwb.titel any "Omgevingsbesluit"`,
      `overheidbwb.titel any "Besluit bouwwerken leefomgeving"`,
      `overheidbwb.titel any "Besluit kwaliteit leefomgeving"`,
      `overheidbwb.titel any "Besluit activiteiten leefomgeving"`,
      `overheidbwb.titel any "Invoeringswet Omgevingswet"`
    ].join(" OR ");

    let items = await bwbSruSearch({ cql: `(${core})`, fetchWithTimeout, max: 25 });
    if (!items.some(x => (x.id || "").toUpperCase() === OMGEVINGSWET_ID)) {
      items.unshift({
        id: OMGEVINGSWET_ID,
        title: "Omgevingswet",
        link: `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`,
        type: "BWB"
      });
    }
    return items;
  }

  // 2) Generic title search
  if (safeQ) {
    const items = await bwbSruSearch({ cql: `overheidbwb.titel any "${safeQ}"`, fetchWithTimeout, max: 25 });
    if (items.length) return items;
  }

  // 3) Keywords fallback
  if (terms.length) {
    const cql = terms.map(t => `overheidbwb.titel any "${t.replaceAll('"', "")}"`).join(" OR ");
    const items = await bwbSruSearch({ cql, fetchWithTimeout, max: 25 });
    if (items.length) return items;
  }

  return [];
}

// ---------------------------
// Source scoring / ranking (municipal noise + national core boost)
// ---------------------------
function scoreSource({ s, q, scope }) {
  if (isBannedSource(s)) return -9999;

  const title = normalize(s?.title || "");
  const qLc = normalize(q);

  let score = 0;

  // Type preference
  if (scope === "municipal") {
    if (s.type === "CVDR") score += 3.0;
    if ((s.type || "").toLowerCase().includes("gemeenteblad")) score += 1.2;
  } else {
    if (s.type === "BWB") score += 2.5;
  }

  // National: strongly prefer Omgevingswet itself for legal-basis questions
  if ((s.id || "").toUpperCase() === OMGEVINGSWET_ID) score += 50;
  if (title.includes("omgevingswet")) score += 15;
  if (title.includes("omgevingsbesluit")) score += 8;
  if (title.includes("besluit bouwwerken leefomgeving")) score += 10;
  if (title.includes("besluit kwaliteit leefomgeving")) score += 10;
  if (title.includes("besluit activiteiten leefomgeving")) score += 9;

  // Push amendment/noise down nationally
  if (title.includes("wijzig") || title.includes("aanvullings") || title.includes("verzamel")) score -= 4;

  // Match question terms
  const terms = extractQueryTerms(q);
  for (const t of terms) {
    if (title.includes(t)) score += 1.2;
  }

  // Municipal noise blacklist (darkstore etc.)
  for (const neg of NEGATIVE_NOISE_TERMS) {
    if (title.includes(normalize(neg))) score -= 8;
  }

  // Gentle boost if user asked about terraces/APV etc.
  if (qLc.includes("terras") && (title.includes("terras") || title.includes("terrassen"))) score += 6;
  if (qLc.includes("apv") && (title.includes("apv") || title.includes("plaatselijke verordening"))) score += 6;

  return score;
}

function rankSources({ sources, q, scope }) {
  const scored = (sources || []).map(s => ({ ...s, _score: scoreSource({ s, q, scope }) }));
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  return scored.filter(x => x._score > -9990);
}

// ---------------------------
// Wetten.overheid.nl norm extraction for Omgevingswet Article 5.1
// (We do this to answer “op grond van welke bepaling” accurately.)
// ---------------------------
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

function sliceArticleSection(text, articleNumber /* "5.1" */) {
  const low = text.toLowerCase();
  const marker = `artikel ${articleNumber}`.toLowerCase();

  let start = low.indexOf(marker);
  if (start === -1) {
    // Sometimes without “Artikel ” in extracted text; try plain
    start = low.indexOf(articleNumber);
    if (start === -1) return null;
  }

  // End at next “Artikel 5.2” if present, otherwise next “Artikel ”
  const nextMarker = `artikel ${articleNumber.split(".")[0]}.${Number(articleNumber.split(".")[1]) + 1}`.toLowerCase();
  let end = low.indexOf(nextMarker, start + marker.length);
  if (end === -1) {
    end = low.indexOf("\nartikel ", start + marker.length);
  }
  if (end === -1) end = Math.min(text.length, start + 4500);

  const section = text.slice(start, end).trim();
  return section.length ? section : null;
}

function pickNormQuoteFromSection(sectionText) {
  if (!sectionText) return null;

  // Normalize whitespace for sentence scanning
  const flat = sectionText.replace(/\s+/g, " ").trim();

  // Prefer a sentence containing “verboden” + “omgevingsvergunning” + (omgevingsplanactiviteit/omgevingsplan)
  const candidates = flat
    .split(/(?<=[\.\:\;])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  const wanted = candidates.find(s =>
    /verboden/i.test(s) &&
    /omgevingsvergunning/i.test(s) &&
    (/omgevingsplan/i.test(s) || /omgevingsplanactiviteit/i.test(s))
  );
  if (wanted) return trimQuoteWords(wanted, 25);

  const fallback1 = candidates.find(s =>
    /verboden/i.test(s) && /omgevingsvergunning/i.test(s)
  );
  if (fallback1) return trimQuoteWords(fallback1, 25);

  const fallback2 = candidates.find(s =>
    /omgevingsvergunning/i.test(s) && (/omgevingsplan/i.test(s) || /omgevingsplanactiviteit/i.test(s))
  );
  if (fallback2) return trimQuoteWords(fallback2, 25);

  // If all else fails, pick a fragment around “omgevingsvergunning”
  const idx = flat.toLowerCase().indexOf("omgevingsvergunning");
  if (idx !== -1) {
    const start = Math.max(0, idx - 160);
    const end = Math.min(flat.length, idx + 240);
    return trimQuoteWords(flat.slice(start, end), 25);
  }

  return null;
}

function trimQuoteWords(s, maxWords = 25) {
  const words = (s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

async function fetchOmgevingswetArt51Norm(fetchWithTimeout) {
  const url = `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`;
  const resp = await fetchWithTimeout(url, {}, 15000);
  const html = await resp.text();
  const text = htmlToTextLite(html);

  const section = sliceArticleSection(text, "5.1");
  const quote = pickNormQuoteFromSection(section);

  return {
    section: section ? section.slice(0, 3200) : null,
    quote: quote ? `"${quote}"` : null
  };
}

// ---------------------------
// Final answer generation (OpenAI) with strict format
// ---------------------------
async function callOpenAI({ apiKey, fetchWithTimeout, q, sourcesText, strictQuote }) {
  const system = `
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen (en eventuele uittreksels).

STRICT:
- Noem GEEN wet/regeling als die naam/titel niet in de bronvermelding/uittreksel staat.
- Noem GEEN artikelnummer/bepaling als die niet letterlijk in de brontekst/uittreksel staat.
- NOOIT Wabo noemen of gebruiken.
- Als een lid/onderdeel niet zichtbaar is: schrijf "lid/onderdeel niet zichtbaar in aangeleverde tekst".
- Als er een verplichte bewijsquote is meegegeven: neem die EXACT over bij Bewijsquote.

Format (exact deze kopjes, elk op eigen regel):
Antwoord:
Grondslag:
Bewijsquote:
Toelichting:
`;

  const user = [
    `Vraag:\n${q}`,
    `\nOfficiële bronnen:\n${sourcesText}`,
    strictQuote ? `\nVERPLICHTE Bewijsquote (exact overnemen):\n${strictQuote}` : ""
  ].join("\n");

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.05,
        max_tokens: 700,
        messages: [
          { role: "system", content: system.trim() },
          { role: "user", content: user.trim() }
        ]
      })
    },
    20000
  );

  const raw = await resp.text();
  try {
    const data = JSON.parse(raw);
    return (data?.choices?.[0]?.message?.content || "").trim();
  } catch {
    return "";
  }
}

function hasAllSections(answer) {
  const a = (answer || "").toLowerCase();
  return a.includes("antwoord:") && a.includes("grondslag:") && a.includes("bewijsquote:") && a.includes("toelichting:");
}

function safeFallbackAnswer({ q, strictQuote, sectionHint }) {
  // Minimal, honest fallback that still “works”
  return [
    "Antwoord:",
    "Ik kan dit niet volledig beantwoorden op basis van de aangeleverde tekst, omdat de exacte bepaling (artikel/lid/onderdeel) niet volledig zichtbaar is.",
    "",
    "Grondslag:",
    sectionHint || "(niet zichtbaar in aangeleverde tekst)",
    "",
    "Bewijsquote:",
    strictQuote || "(geen quote beschikbaar in aangeleverde tekst)",
    "",
    "Toelichting:",
    "- De beantwoording is beperkt tot wat in de aangeleverde bronnen/uittreksels letterlijk staat."
  ].join("\n");
}

// ---------------------------
// MAIN HANDLER (single export)
// ---------------------------
export default async function handler(req, res) {
  // ---- CORS / PREFLIGHT FIRST (Safari-friendly) ----
  const origin = (req.headers.origin || "").toString();
  if (origin === "https://app.beleidsbank.nl") {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://app.beleidsbank.nl");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // ---- Rate limit ----
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  // ---- Input ----
  const { message, session_id } = req.body || {};
  const sessionId = (session_id || "").toString().trim();
  let q = (message || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing message" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt.", sources: [] });

  const fetchWithTimeout = makeFetchWithTimeout();

  try {
    // -----------------------------
    // 0) Slot follow-up handling
    // -----------------------------
    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (nowMs() - pending.createdAt) < 7 * 60 * 1000;

    let collected = {};
    if (fresh) {
      collected = { ...(pending.collected || {}) };
      const missing = (pending.missingSlots || []).filter(s => ALLOWED_SLOTS.includes(s));
      const attempts = Number.isFinite(pending.attempts) ? pending.attempts : 0;
      const MAX_ATTEMPTS = 3;

      // Heuristic slot extraction (no extra model call)
      if (missing.includes("municipality") && !collected.municipality && looksLikeMunicipality(q)) {
        collected.municipality = q.trim();
      }
      if (missing.includes("location_hint") && !collected.location_hint && hasMeaningfulDetail(q)) {
        collected.location_hint = q.trim();
      }
      if (missing.includes("activity_hint") && !collected.activity_hint && hasMeaningfulDetail(q)) {
        collected.activity_hint = q.trim();
      }
      if (missing.includes("topic_hint") && !collected.topic_hint && hasMeaningfulDetail(q)) {
        collected.topic_hint = q.trim();
      }

      const stillMissing = [];
      for (const slot of missing) {
        if (slot === "municipality" && !collected.municipality) stillMissing.push("municipality");
        if (slot === "location_hint" && !collected.location_hint) stillMissing.push("location_hint");
        if (slot === "activity_hint" && !collected.activity_hint) stillMissing.push("activity_hint");
        if (slot === "topic_hint" && !collected.topic_hint) stillMissing.push("topic_hint");
      }

      if (stillMissing.length && attempts < MAX_ATTEMPTS) {
        pending.missingSlots = stillMissing;
        pending.collected = collected;
        pending.attempts = attempts + 1;
        pendingStore.set(sessionId, pending);
        return res.status(200).json({ answer: askForMissing(stillMissing), sources: [] });
      }

      q = pending.originalQuestion;
      pendingStore.delete(sessionId);
    }

    // -----------------------------
    // 1) Scope decision
    // -----------------------------
    const scope = decideScope(q);
    const qLc = normalize(q);

    // If municipal: require municipality
    if (scope === "municipal" && !collected.municipality) {
      const need = ["municipality"];

      // If very short municipal query, ask one extra helpful slot (not 10 topics)
      const words = (q || "").trim().split(/\s+/).filter(Boolean);
      if (words.length <= 4) need.push("activity_hint");

      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots: need,
          collected: { ...collected },
          createdAt: nowMs(),
          attempts: 0
        });
      }
      return res.status(200).json({ answer: askForMissing(need), sources: [] });
    }

    // If national and too vague: ask topic hint (generic)
    if (scope === "national" && shouldAskMore(q, scope) && !collected.topic_hint) {
      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots: ["topic_hint"],
          collected: { ...collected },
          createdAt: nowMs(),
          attempts: 0
        });
      }
      return res.status(200).json({ answer: questionForSlot("topic_hint"), sources: [] });
    }

    // -----------------------------
    // 2) Build a stable topicText (for municipal SRU)
    // -----------------------------
    const extra = [
      collected.activity_hint,
      collected.location_hint,
      collected.topic_hint
    ].filter(hasMeaningfulDetail).join(" ");

    const topicText = `${q} ${extra}`.trim();

    // -----------------------------
    // 3) Fetch sources (municipal or national)
    // -----------------------------
    let sources = [];

    if (scope === "municipal") {
      const mun = collected.municipality;

      // Strategy:
      // 1) CVDR (verordeningen) then 2) OEP (besluiten/beleidsregels)
      sources = await cvdrSearch({ municipalityName: mun, topicText, fetchWithTimeout });
      if (!sources.length) sources = await oepSearch({ municipalityName: mun, topicText, fetchWithTimeout });

      // If still empty, try slight fallback: key terms only
      if (!sources.length) {
        const keyTerms = extractQueryTerms(q).join(" ");
        sources = await cvdrSearch({ municipalityName: mun, topicText: keyTerms || q, fetchWithTimeout });
        if (!sources.length) sources = await oepSearch({ municipalityName: mun, topicText: keyTerms || q, fetchWithTimeout });
      }
    } else {
      // NATIONAL
      const forceOw =
        isLegalBasisQuestion(qLc) ||
        qLc.includes("omgevingsplan") ||
        qLc.includes("omgevingsvergunning") ||
        qLc.includes("omgevingsplanactiviteit") ||
        qLc.includes("bopa") ||
        qLc.includes("afwijken van het omgevingsplan") ||
        qLc.includes("tijdelijk afwijken");

      const q2 = `${q} ${extra}`.trim();
      sources = await bwbSearchSmart({ q: q2, fetchWithTimeout, forceOw });
    }

    sources = removeBanned(dedupeByLink(sources));

    // Rank & trim
    sources = rankSources({ sources, q, scope }).slice(0, MAX_SOURCES_RETURN).map(({ _score, ...s }) => s);

    if (!sources.length) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden. Formuleer specifieker met kernbegrippen (en bij gemeentelijke vragen: de gemeente).",
        sources: []
      });
    }

    // -----------------------------
    // 4) If legal-basis omgevingsplan question -> add Omgevingswet Art.5.1 norm snippet + strict quote
    // -----------------------------
    const needsOwNorm =
      scope === "national" &&
      (isLegalBasisQuestion(qLc) ||
        qLc.includes("omgevingsplan") ||
        qLc.includes("omgevingsplanactiviteit") ||
        qLc.includes("afwijken") ||
        qLc.includes("tijdelijk") ||
        qLc.includes("bopa"));

    let owNorm = { section: null, quote: null };
    if (needsOwNorm) {
      try {
        owNorm = await fetchOmgevingswetArt51Norm(fetchWithTimeout);
      } catch {
        owNorm = { section: null, quote: null };
      }
    }

    // -----------------------------
    // 5) Build sourcesText (include uittreksel when available)
    // -----------------------------
    const sourcesText = sources
      .map((s, i) => {
        const head = `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}`;
        const isOw = (s.id || "").toUpperCase() === OMGEVINGSWET_ID || normalize(s.title) === "omgevingswet";
        if (isOw && owNorm.section) {
          return `${head}\n\nUittreksel (relevant):\n${owNorm.section}`;
        }
        return head;
      })
      .join("\n\n---\n\n");

    // Strict quote enforcement only if we found a norm-candidate quote
    const strictQuote = owNorm.quote || null;

    // -----------------------------
    // 6) Ask model to answer ONLY from sources
    // -----------------------------
    let answer = await callOpenAI({
      apiKey,
      fetchWithTimeout,
      q: `${q}${scope === "municipal" && collected.municipality ? ` (Gemeente: ${collected.municipality})` : ""}`,
      sourcesText,
      strictQuote
    });

    answer = stripSourcesFromAnswer(answer);

    // -----------------------------
    // 7) Safety post-validation (format + quote + bans)
    // -----------------------------
    const ansLc = normalize(answer);

    // Ban Wabo leakage
    if (ansLc.includes("wabo") || ansLc.includes("wet algemene bepalingen omgevingsrecht")) {
      answer = safeFallbackAnswer({
        q,
        strictQuote,
        sectionHint: "Omgevingswet (Wabo niet toegestaan)"
      });
    }

    // Require sections
    if (!hasAllSections(answer)) {
      answer = safeFallbackAnswer({
        q,
        strictQuote,
        sectionHint: strictQuote ? "Omgevingswet artikel 5.1 (uittreksel aangeleverd)" : "(niet zichtbaar in aangeleverde tekst)"
      });
    }

    // If strictQuote expected, it must appear exactly
    if (strictQuote && !answer.includes(strictQuote)) {
      answer = safeFallbackAnswer({
        q,
        strictQuote,
        sectionHint: "Omgevingswet artikel 5.1 (normtekst uittreksel aangeleverd)"
      });
    }

    // If model tries to use a “hoofdstuk” as quote while strictQuote exists, fallback
    if (strictQuote && /bewijsquote:\s*["']?\s*hoofdstuk/i.test(answer)) {
      answer = safeFallbackAnswer({
        q,
        strictQuote,
        sectionHint: "Omgevingswet artikel 5.1 (normtekst uittreksel aangeleverd)"
      });
    }

    // Never return banned sources
    const safeSources = removeBanned(sources).slice(0, MAX_SOURCES_RETURN);

    return res.status(200).json({ answer, sources: safeSources });
  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
