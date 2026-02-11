// /api/chat.js
// ✅ Fix for your CURRENT failure:
// Your model still uses a HEADER as “Bewijsquote”: "Artikel 5.1 (omgevingsvergunningplichtige activiteiten wet)"
//
// Root cause:
// - “omgevingsvergunningplichtige” contains the substring “plicht”, so a naive check for “plicht” mistakenly
//   accepts a header as a “normquote”.
// - If no real normquote is found, the answer MUST contain the placeholder "(geen normquote gevonden ...)".
//   If it doesn’t: hard fallback.
//
// This version:
// ✅ Treats “Artikel 5.1 …” and “omgevingsvergunningplichtige activiteiten” as HEADER (never valid quote)
// ✅ Normquote is only valid if it contains: (verboden) OR (zonder omgevingsvergunning) OR (is vereist/vereist) as a norm sentence
// ✅ If we didn’t find a normquote server-side, we FORCE the placeholder; any other quote triggers fallback
// ✅ If we DID find a normquote, model must include it EXACTLY; otherwise fallback
// ✅ Wabo hard-banned
// ✅ Scope: “welke bepaling/grondslag” => NATIONAL (BWB) (no municipality loop)
// ✅ Municipal SRU still works for APV/terras etc.

const rateStore = new Map();
const pendingStore = new Map(); // sessionId -> { originalQuestion, missingSlots:[], collected:{}, createdAt, attempts }

const MAX_SOURCES_RETURN = 4;

// ---------------------------
// Basics
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
  const badExact = new Set(["?", "??", "???", "geen idee", "weet ik niet", "idk", "geen", "nvt", "organisatie?", "context", "help"]);
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
// Hard bans (Wabo never)
// ---------------------------
const BANNED_BWBR_IDS = new Set([
  "BWBR0024779", // Wabo official
  "BWBR0047270"  // seen earlier
]);

function isBannedSource(item) {
  const id = (item?.id || "").toString().trim().toUpperCase();
  const title = normalize(item?.title || "");
  if (id && BANNED_BWBR_IDS.has(id)) return true;
  if (title.includes("wabo")) return true;
  if (title.includes("wet algemene bepalingen omgevingsrecht")) return true;
  if (title.includes("algemene bepalingen omgevingsrecht")) return true;
  return false;
}

function removeBanned(items) {
  return (items || []).filter(x => !isBannedSource(x));
}

// ---------------------------
// Follow-up slots (minimal)
// ---------------------------
const ALLOWED_SLOTS = ["municipality", "topic_hint", "activity_hint", "location_hint"];

function questionForSlot(slot) {
  if (slot === "municipality") return "Voor welke gemeente geldt dit?";
  if (slot === "topic_hint") return "Waar gaat uw vraag precies over? (bv. bouwen, milieu, handhaving, subsidies, onderwijs, verkeer)";
  if (slot === "activity_hint") return "Wat is de activiteit/context? (bv. horeca, bouw, evenement, handhaving, parkeren, subsidie)";
  if (slot === "location_hint") return "Gaat het om een specifieke locatie/gebied? (bv. straat/wijk, of ‘eigen terrein’ / ‘openbare ruimte’)";
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
// Scope detection
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
  return (
    (qLc.includes("wat staat er in") && qLc.includes("omgevingsplan")) ||
    (qLc.includes("regels") && qLc.includes("omgevingsplan") && (qLc.includes("adres") || qLc.includes("locatie") || qLc.includes("perceel") || qLc.includes("gebied"))) ||
    (qLc.includes("omgevingsplan") && qLc.includes("van de gemeente") && !isLegalBasisQuestion(qLc))
  );
}

function decideScope(q) {
  const qLc = normalize(q);
  if (isLegalBasisQuestion(qLc)) return "national";
  if (isExplicitMunicipalTopic(qLc)) return "municipal";
  if (isOmgevingsplanLocalInterpretationQuestion(qLc)) return "municipal";
  return "national";
}

function shouldAskMore(q, scope) {
  const words = (q || "").trim().split(/\s+/).filter(Boolean);
  if (scope === "national") return (q || "").trim().length < 18 || words.length <= 3;
  return false;
}

// ---------------------------
// Terms (generic)
// ---------------------------
function extractQueryTerms(q) {
  const qLc = normalize(q);
  const words = qLc.split(/[^a-z0-9áéíóúàèìòùäëïöüçñ\-]+/i).filter(Boolean);
  const keep = [];
  for (const w of words) {
    if (w.length < 4) continue;
    if (["voor", "naar", "door", "over", "onder", "tussen", "zodat", "waarom", "welke", "bepaling", "artikel", "grond", "grondslag"].includes(w)) continue;
    keep.push(w);
  }
  return [...new Set(keep)].slice(0, 10);
}

// ---------------------------
// SRU searches
// ---------------------------
async function cvdrSearch({ municipalityName, topicText, fetchWithTimeout }) {
  const base = "https://zoekdienst.overheid.nl/sru/Search";
  const creatorsToTry = [municipalityName, `Gemeente ${municipalityName}`, `gemeente ${municipalityName}`];
  const safeTopic = (topicText || "").replaceAll('"', "").trim() || "";

  for (const creator of creatorsToTry) {
    const cql = `(dcterms.creator="${creator}") AND (keyword all "${safeTopic}")`;
    const url =
      `${base}?version=1.2` +
      `&operation=searchRetrieve&x-connection=cvdr&x-info-1-accept=any` +
      `&maximumRecords=25&startRecord=1&query=${encodeURIComponent(cql)}`;

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
    `&operation=searchRetrieve&x-connection=oep&recordSchema=dc` +
    `&maximumRecords=25&startRecord=1&query=${encodeURIComponent(cql)}`;

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
    `&maximumRecords=${max}&startRecord=1&query=${encodeURIComponent(cql)}`;

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

  return removeBanned(dedupeByLink(items));
}

async function bwbSearchSmart({ q, fetchWithTimeout, forceOw }) {
  const qLc = normalize(q);
  const safeQ = (q || "").replaceAll('"', "").trim();
  const terms = extractQueryTerms(q).slice(0, 6);

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
      `overheidbwb.titel any "Invoeringswet Omgevingswet"`,
      `overheidbwb.titel any "Invoeringsbesluit Omgevingswet"`
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

  if (safeQ) {
    const items = await bwbSruSearch({ cql: `overheidbwb.titel any "${safeQ}"`, fetchWithTimeout, max: 25 });
    if (items.length) return items;
  }

  if (terms.length) {
    const cql = terms.map(t => `overheidbwb.titel any "${t.replaceAll('"', "")}"`).join(" OR ");
    const items = await bwbSruSearch({ cql, fetchWithTimeout, max: 25 });
    if (items.length) return items;
  }

  return [];
}

// ---------------------------
// Ranking (simple, stable)
// ---------------------------
function scoreSource({ s, q, scope }) {
  if (isBannedSource(s)) return -9999;
  const title = normalize(s?.title || "");
  const qLc = normalize(q);

  let score = 0;

  if (scope === "municipal") {
    if (s.type === "CVDR") score += 3.0;
    if ((s.type || "").toLowerCase().includes("gemeenteblad")) score += 1.2;
  } else {
    if (s.type === "BWB") score += 2.5;
  }

  if ((s.id || "").toUpperCase() === OMGEVINGSWET_ID) score += 60;
  if (title.includes("omgevingswet")) score += 18;
  if (title.includes("omgevingsbesluit")) score += 10;
  if (title.includes("besluit bouwwerken leefomgeving")) score += 12;
  if (title.includes("besluit kwaliteit leefomgeving")) score += 12;
  if (title.includes("besluit activiteiten leefomgeving")) score += 11;

  if (title.includes("wijzig") || title.includes("aanvullings") || title.includes("verzamel")) score -= 4;

  const terms = extractQueryTerms(q);
  for (const t of terms) if (title.includes(t)) score += 1.0;

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
// Omgevingswet norm extraction (hard requirement: true norm sentence)
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
  if (start === -1) return null;

  const parts = articleNumber.split(".");
  const nextMarker = `artikel ${parts[0]}.${Number(parts[1]) + 1}`.toLowerCase();
  let end = low.indexOf(nextMarker, start + marker.length);
  if (end === -1) end = low.indexOf("\nartikel ", start + marker.length);
  if (end === -1) end = Math.min(text.length, start + 9000);

  const section = text.slice(start, end).trim();
  return section.length ? section : null;
}

function trimQuoteWords(s, maxWords = 25) {
  const words = (s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

function isHeaderLike(line) {
  const l = normalize(line);
  if (!l) return true;
  if (l.startsWith("artikel 5.1")) return true;
  if (l.startsWith("hoofdstuk")) return true;
  if (l.startsWith("afdeling")) return true;
  if (l.startsWith("paragraaf")) return true;
  if (l.includes("omgevingsvergunningplichtige activiteiten")) return true; // IMPORTANT
  return false;
}

// A “normquote” must contain at least one of these norm-patterns AND "omgevingsvergunning"
function isNormSentence(line) {
  const l = normalize(line);
  if (!l.includes("omgevingsvergunning")) return false;

  const normOk =
    /\bverboden\b/.test(l) ||
    /zonder\s+omgevingsvergunning/.test(l) ||
    /\bis\s+vereist\b/.test(l) ||
    /\bvereist\b/.test(l);

  if (!normOk) return false;

  // Prefer omgevingsplan(activiteit) mention, but not strictly required
  return true;
}

function pickNormQuoteFromArticleSection(sectionText) {
  if (!sectionText) return null;

  const lines = sectionText
    .replace(/\r/g, "\n")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const contentLines = lines.filter(l => !isHeaderLike(l));

  // Best: contains "verboden" + "omgevingsvergunning" + (omgevingsplan/omgevingsplanactiviteit)
  let best = contentLines.find(l => {
    const lc = normalize(l);
    return (
      /\bverboden\b/.test(lc) &&
      lc.includes("omgevingsvergunning") &&
      (lc.includes("omgevingsplan") || lc.includes("omgevingsplanactiviteit"))
    );
  });

  if (!best) best = contentLines.find(isNormSentence);

  if (!best) {
    // Try flat fragment, but still must pass isNormSentence
    const flat = contentLines.join(" ").replace(/\s+/g, " ").trim();
    const idx = flat.toLowerCase().indexOf("omgevingsvergunning");
    if (idx !== -1) {
      const start = Math.max(0, idx - 260);
      const end = Math.min(flat.length, idx + 420);
      const frag = flat.slice(start, end);
      if (isNormSentence(frag) && !isHeaderLike(frag)) best = frag;
    }
  }

  if (!best) return null;

  const quote = trimQuoteWords(best, 25);
  if (isHeaderLike(quote)) return null;
  if (!isNormSentence(quote)) return null;

  return `"${quote}"`;
}

async function fetchOmgevingswetArt51Norm(fetchWithTimeout) {
  const url = `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`;
  const resp = await fetchWithTimeout(url, {}, 15000);
  const html = await resp.text();
  const text = htmlToTextLite(html);

  const section = sliceArticleSection(text, "5.1");
  const quote = pickNormQuoteFromArticleSection(section);

  return {
    section: section ? section.slice(0, 4200) : null,
    quote // null if no true norm sentence was found
  };
}

// ---------------------------
// OpenAI call (strict)
// ---------------------------
async function callOpenAI({ apiKey, fetchWithTimeout, q, sourcesText, strictQuote }) {
  const system = `
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen (incl. uittreksels).

STRICT:
- Noem GEEN wet/regeling als die naam/titel niet in de bronvermelding/uittreksel staat.
- Noem GEEN artikelnummer/bepaling als die niet letterlijk in de brontekst/uittreksel staat.
- NOOIT Wabo noemen of gebruiken.
- Als er een verplichte bewijsquote is meegegeven: neem die EXACT over bij Bewijsquote (geen parafrase).
- Als er géén verplichte bewijsquote is meegegeven: zet bij Bewijsquote exact "(geen normquote gevonden in aangeleverde tekst)".
- Als je geen normquote hebt: zeg NIET dat iets “vereist” is; zeg dan dat de aangeleverde tekst geen expliciete normzin toont.

Format (exact deze kopjes, elk op eigen regel):
Antwoord:
Grondslag:
Bewijsquote:
Toelichting:
`;

  const user = [
    `Vraag:\n${q}`,
    `\nOfficiële bronnen:\n${sourcesText}`,
    strictQuote
      ? `\nVERPLICHTE Bewijsquote (exact overnemen):\n${strictQuote}`
      : `\nEr is géén normquote gevonden; gebruik de placeholder bij Bewijsquote.`
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

function extractBewijsquote(answer) {
  // robust block extraction: take everything after "Bewijsquote:" until "\nToelichting:" or end
  const m = (answer || "").match(/bewijsquote:\s*([\s\S]*?)(\n\s*toelichting\s*:|$)/i);
  if (!m) return "";
  return (m[1] || "").trim();
}

const NO_QUOTE_PLACEHOLDER = "(geen normquote gevonden in aangeleverde tekst)";

function safeFallbackAnswer({ strictQuote }) {
  return [
    "Antwoord:",
    strictQuote
      ? "Op basis van de aangeleverde normzin in de Omgevingswet geldt dat voor de betreffende activiteit een omgevingsvergunning is vereist/verboden zonder vergunning."
      : "Ik kan niet bevestigen dat dit ‘vereist’ is op basis van de aangeleverde tekst, omdat er geen expliciete normzin zichtbaar is.",
    "",
    "Grondslag:",
    strictQuote ? "Artikel 5.1 Omgevingswet (lid/onderdeel: niet zichtbaar in aangeleverde tekst)" : "(niet zichtbaar in aangeleverde tekst)",
    "",
    "Bewijsquote:",
    strictQuote || NO_QUOTE_PLACEHOLDER,
    "",
    "Toelichting:",
    "- Alleen informatie die letterlijk in de aangeleverde bronnen/uittreksels staat kan worden gebruikt."
  ].join("\n");
}

// ---------------------------
// MAIN
// ---------------------------
export default async function handler(req, res) {
  // ---- CORS / PREFLIGHT FIRST (Safari) ----
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

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const { message, session_id } = req.body || {};
  const sessionId = (session_id || "").toString().trim();
  let q = (message || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing message" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt.", sources: [] });

  const fetchWithTimeout = makeFetchWithTimeout();

  try {
    // -----------------------------
    // 0) Follow-up flow
    // -----------------------------
    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (nowMs() - pending.createdAt) < 7 * 60 * 1000;

    let collected = {};
    if (fresh) {
      collected = { ...(pending.collected || {}) };
      const missing = (pending.missingSlots || []).filter(s => ALLOWED_SLOTS.includes(s));
      const attempts = Number.isFinite(pending.attempts) ? pending.attempts : 0;
      const MAX_ATTEMPTS = 3;

      if (missing.includes("municipality") && !collected.municipality && looksLikeMunicipality(q)) collected.municipality = q.trim();
      if (missing.includes("topic_hint") && !collected.topic_hint && hasMeaningfulDetail(q)) collected.topic_hint = q.trim();
      if (missing.includes("activity_hint") && !collected.activity_hint && hasMeaningfulDetail(q)) collected.activity_hint = q.trim();
      if (missing.includes("location_hint") && !collected.location_hint && hasMeaningfulDetail(q)) collected.location_hint = q.trim();

      const stillMissing = [];
      for (const slot of missing) {
        if (slot === "municipality" && !collected.municipality) stillMissing.push("municipality");
        if (slot === "topic_hint" && !collected.topic_hint) stillMissing.push("topic_hint");
        if (slot === "activity_hint" && !collected.activity_hint) stillMissing.push("activity_hint");
        if (slot === "location_hint" && !collected.location_hint) stillMissing.push("location_hint");
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

    if (scope === "municipal" && !collected.municipality) {
      const need = ["municipality"];
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
    // 2) Search sources
    // -----------------------------
    const extra = [collected.topic_hint, collected.activity_hint, collected.location_hint].filter(hasMeaningfulDetail).join(" ");
    const topicText = `${q} ${extra}`.trim();

    let sources = [];

    if (scope === "municipal") {
      const mun = collected.municipality;
      sources = await cvdrSearch({ municipalityName: mun, topicText, fetchWithTimeout });
      if (!sources.length) sources = await oepSearch({ municipalityName: mun, topicText, fetchWithTimeout });

      if (!sources.length) {
        const keyTerms = extractQueryTerms(q).join(" ");
        sources = await cvdrSearch({ municipalityName: mun, topicText: keyTerms || q, fetchWithTimeout });
        if (!sources.length) sources = await oepSearch({ municipalityName: mun, topicText: keyTerms || q, fetchWithTimeout });
      }
    } else {
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
    sources = rankSources({ sources, q, scope }).slice(0, MAX_SOURCES_RETURN).map(({ _score, ...s }) => s);

    if (!sources.length) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden. Formuleer specifieker met kernbegrippen (en bij gemeentelijke vragen: de gemeente).",
        sources: []
      });
    }

    // -----------------------------
    // 3) Normquote (real norm sentence only)
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

    const sourcesText = sources
      .map((s, i) => {
        const head = `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}`;
        const isOw = (s.id || "").toUpperCase() === OMGEVINGSWET_ID || normalize(s.title) === "omgevingswet";
        if (isOw && owNorm.section) return `${head}\n\nUittreksel (relevant):\n${owNorm.section}`;
        return head;
      })
      .join("\n\n---\n\n");

    // -----------------------------
    // 4) Generate answer
    // -----------------------------
    let answer = await callOpenAI({
      apiKey,
      fetchWithTimeout,
      q: `${q}${scope === "municipal" && collected.municipality ? ` (Gemeente: ${collected.municipality})` : ""}`,
      sourcesText,
      strictQuote: owNorm.quote // null if not found
    });

    answer = stripSourcesFromAnswer(answer);

    // -----------------------------
    // 5) Post-validation (THE IMPORTANT FIX)
    // -----------------------------
    const ansLc = normalize(answer);

    if (ansLc.includes("wabo") || ansLc.includes("wet algemene bepalingen omgevingsrecht")) {
      answer = safeFallbackAnswer({ strictQuote: owNorm.quote || NO_QUOTE_PLACEHOLDER });
    }

    if (!hasAllSections(answer)) {
      answer = safeFallbackAnswer({ strictQuote: owNorm.quote || NO_QUOTE_PLACEHOLDER });
    }

    const bewijsquote = extractBewijsquote(answer);
    const bqLc = normalize(bewijsquote);

    // If strictQuote exists, it MUST be included exactly
    if (owNorm.quote && !answer.includes(owNorm.quote)) {
      answer = safeFallbackAnswer({ strictQuote: owNorm.quote });
    }

    // If no strictQuote exists, the quote MUST be the placeholder
    if (!owNorm.quote) {
      // Any other quote (like "Artikel 5.1 ...") is invalid
      if (!bqLc.includes(NO_QUOTE_PLACEHOLDER)) {
        answer = safeFallbackAnswer({ strictQuote: NO_QUOTE_PLACEHOLDER });
      }
    }

    // Reject header-like quotes ALWAYS
    if (bqLc.includes("artikel 5.1") || bqLc.includes("hoofdstuk") || bqLc.includes("omgevingsvergunningplichtige activiteiten")) {
      // Only allow if it’s exactly the strict quote and that strict quote is a real norm sentence (it will not be a header)
      if (!owNorm.quote || !answer.includes(owNorm.quote)) {
        answer = safeFallbackAnswer({ strictQuote: owNorm.quote || NO_QUOTE_PLACEHOLDER });
      }
    }

    // Reject “impliceert” style reasoning if no normquote exists
    if (!owNorm.quote && ansLc.includes("impliceert")) {
      answer = safeFallbackAnswer({ strictQuote: NO_QUOTE_PLACEHOLDER });
    }

    // Never return banned sources
    const safeSources = removeBanned(sources).slice(0, MAX_SOURCES_RETURN);

    return res.status(200).json({ answer, sources: safeSources });
  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
