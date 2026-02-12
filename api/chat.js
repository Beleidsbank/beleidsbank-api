// /api/chat.js  (Beleidsbank) — v1.2 (Praktisch + actueel, zonder Canvas)
//
// Belangrijk (jouw wensen):
// ✅ Altijd precies 3 koppen in response:
//    Antwoord:
//    Toelichting:
//    Bronnen:
//
// ✅ Actualiteit: Wabo is hard-banned (IDs + titel match) → komt nooit terug
// ✅ Niet “kapot streng”: als er géén normquote is, geven we wél een bruikbaar antwoord als INDICATIE
//    (dus niet hard “kan niet bevestigen”, tenzij er echt nul basis is)
// ✅ Backend plakt Bronnen er altijd zelf onder (model mag geen Bronnen printen)
// ✅ Prevent “dubbele Bronnen:” (fix regex + harde strip)
// ✅ Cleanup van in-memory stores om traagheid te voorkomen
// ✅ (Extra) Gemeentelijk: haal kleine uittreksels op van top CVDR/OEP bronnen zodat model iets heeft

const rateStore = new Map();
const pendingStore = new Map(); // sessionId -> { originalQuestion, missingSlots:[], collected:{}, createdAt, attempts }
const cacheStore = new Map();   // key -> { value, expiresAt }

const MAX_SOURCES_RETURN = 4;

// ---------------------------
// Basics
// ---------------------------
function nowMs() { return Date.now(); }

function cleanupStores() {
  const now = nowMs();

  // pendingStore: expire after 7 minutes
  for (const [k, v] of pendingStore.entries()) {
    const createdAt = Number(v?.createdAt || 0);
    if (!createdAt || (now - createdAt) > 7 * 60 * 1000) pendingStore.delete(k);
  }

  // rateStore: remove entries long after resetAt
  for (const [ip, v] of rateStore.entries()) {
    const resetAt = Number(v?.resetAt || 0);
    if (!resetAt || now > (resetAt + 2 * 60 * 1000)) rateStore.delete(ip);
  }

  // cacheStore: remove expired
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
// Actualiteit / Hard bans (Wabo NEVER)
// ---------------------------
const BANNED_BWBR_IDS = new Set([
  "BWBR0024779", // Wabo
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
// Terms
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
    // Prefer stable core set for the stelsel (less noise)
    const core = [
      `overheidbwb.titel any "Omgevingswet"`,
      `overheidbwb.titel any "Omgevingsbesluit"`,
      `overheidbwb.titel any "Besluit bouwwerken leefomgeving"`,
      `overheidbwb.titel any "Besluit kwaliteit leefomgeving"`,
      `overheidbwb.titel any "Besluit activiteiten leefomgeving"`
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
// Ranking
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

  // Strong stelsel priorities
  if ((s.id || "").toUpperCase() === OMGEVINGSWET_ID) score += 80;
  if (title === "omgevingswet") score += 25;
  if (title.includes("omgevingswet")) score += 18;
  if (title.includes("omgevingsbesluit")) score += 16;
  if (title.includes("besluit bouwwerken leefomgeving")) score += 16;
  if (title.includes("besluit kwaliteit leefomgeving")) score += 16;
  if (title.includes("besluit activiteiten leefomgeving")) score += 15;

  // Push down noise
  if (title.includes("vaststelling tijdstip") || title.includes("bepaling termijn")) score -= 20;
  if (title.includes("aanvullingswet") || title.includes("aanvullingsbesluit")) score -= 10;
  if (title.includes("verzamel")) score -= 8;
  if (title.includes("wijzig")) score -= 6;
  if (title.includes("invoeringswet")) score -= 4;
  if (title.includes("invoeringsbesluit")) score -= 4;

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
// Text helpers
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

function trimQuoteWords(s, maxWords = 25) {
  const words = (s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

// ---------------------------
// Omgevingswet norm extraction (try more than only 5.1)
// ---------------------------
function isHeaderLike(line) {
  const l = normalize(line);
  if (!l) return true;
  if (l.startsWith("artikel")) return true;
  if (l.startsWith("hoofdstuk")) return true;
  if (l.startsWith("afdeling")) return true;
  if (l.startsWith("paragraaf")) return true;
  if (l.includes("omgevingsvergunningplichtige activiteiten")) return true;
  return false;
}

function isNormSentence(line) {
  const l = normalize(line);
  if (!l.includes("omgevingsvergunning")) return false;

  const normOk =
    /\bverboden\b/.test(l) ||
    /zonder\s+omgevingsvergunning/.test(l) ||
    /\bis\s+vereist\b/.test(l) ||
    /\bvereist\b/.test(l);

  return !!normOk;
}

function pickNormQuoteFromText(text) {
  if (!text) return null;
  const lines = text.replace(/\r/g, "\n").split("\n").map(x => x.trim()).filter(Boolean);
  const content = lines.filter(l => !isHeaderLike(l));
  let best = content.find(isNormSentence);

  if (!best) {
    const flat = content.join(" ").replace(/\s+/g, " ").trim();
    const idx = flat.toLowerCase().indexOf("omgevingsvergunning");
    if (idx !== -1) {
      const frag = flat.slice(Math.max(0, idx - 260), Math.min(flat.length, idx + 420));
      if (isNormSentence(frag) && !isHeaderLike(frag)) best = frag;
    }
  }

  if (!best) return null;
  const quote = trimQuoteWords(best, 25);
  if (isHeaderLike(quote)) return null;
  if (!isNormSentence(quote)) return null;
  return `"${quote}"`;
}

function sliceArticleSection(text, articleNumber /* "5.1" */) {
  const low = (text || "").toLowerCase();
  const marker = `artikel ${articleNumber}`.toLowerCase();
  let start = low.indexOf(marker);
  if (start === -1) return null;

  // find next "artikel X.Y"
  const tail = low.slice(start + marker.length);
  const m = tail.match(/\nartikel\s+\d+\.\d+\b/i);
  const end = m?.index != null ? (start + marker.length + m.index) : Math.min(text.length, start + 9000);

  const section = text.slice(start, end).trim();
  return section.length ? section : null;
}

async function fetchOmgevingswetNorm(fetchWithTimeout) {
  const cacheKey = `ow:${OMGEVINGSWET_ID}:multi`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`;
  const resp = await fetchWithTimeout(url, {}, 15000);
  const html = await resp.text();
  const text = htmlToTextLite(html);

  // Try multiple likely articles
  const candidates = ["5.1", "5.2", "5.3", "5.4"].map(n => sliceArticleSection(text, n)).filter(Boolean);

  let section = null;
  let quote = null;

  for (const sec of candidates) {
    const q = pickNormQuoteFromText(sec);
    if (q) { section = sec; quote = q; break; }
  }

  // broader fallback near first "omgevingsvergunning"
  if (!quote) {
    const idx = text.toLowerCase().indexOf("omgevingsvergunning");
    if (idx !== -1) {
      const frag = text.slice(Math.max(0, idx - 2000), Math.min(text.length, idx + 2500));
      const q = pickNormQuoteFromText(frag);
      if (q) { section = frag; quote = q; }
    }
  }

  const out = {
    section: section ? section.slice(0, 4200) : null,
    quote
  };

  cacheSet(cacheKey, out, 12 * 60 * 60 * 1000);
  return out;
}

// ---------------------------
// Municipal excerpt enrichment (small + cached)
// ---------------------------
function pickRelevantLines(text, keywords, maxLines = 12) {
  const lines = (text || "").split("\n").map(l => l.trim()).filter(Boolean);
  const key = (keywords || []).map(k => normalize(k)).filter(Boolean);
  const out = [];
  for (const l of lines) {
    const lc = normalize(l);
    if (!lc) continue;
    if (key.some(k => lc.includes(k))) out.push(l);
    if (out.length >= maxLines) break;
  }
  return out;
}

function isMunicipalNormLine(line) {
  const l = normalize(line);
  if (!l.includes("vergunning")) return false;
  return (
    l.includes("verboden") ||
    l.includes("verplicht") ||
    l.includes("is vereist") ||
    l.includes("vereist") ||
    l.includes("zonder vergunning") ||
    l.includes("mag niet")
  );
}

function pickMunicipalNormQuote(text) {
  const lines = (text || "").split("\n").map(x => x.trim()).filter(Boolean);
  const hit = lines.find(isMunicipalNormLine);
  if (!hit) return null;
  return `"${trimQuoteWords(hit, 28)}"`;
}

async function fetchMunicipalExcerpt({ url, fetchWithTimeout, keywords }) {
  const cacheKey = `mun:${url}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetchWithTimeout(url, {}, 15000);
    const html = await resp.text();
    const text = htmlToTextLite(html);

    const quote = pickMunicipalNormQuote(text);
    const lines = pickRelevantLines(text, keywords, 12);
    const excerpt = lines.length ? lines.join("\n") : text.slice(0, 1400);

    const out = { excerpt: excerpt.slice(0, 3200), quote };
    cacheSet(cacheKey, out, 6 * 60 * 60 * 1000);
    return out;
  } catch {
    const out = { excerpt: null, quote: null };
    cacheSet(cacheKey, out, 30 * 60 * 1000);
    return out;
  }
}

// ---------------------------
// Output helpers (3 headings)
// ---------------------------
const NO_QUOTE_PLACEHOLDER = "(geen normquote gevonden in aangeleverde tekst)";

function formatSourcesBlock(sources) {
  const lines = (sources || []).map((s, i) => {
    const title = (s?.title || s?.id || `Bron ${i + 1}`).toString().trim();
    const link = (s?.link || "").toString().trim();
    const type = (s?.type || "").toString().trim();
    const meta = [type, s?.id].filter(Boolean).join(" · ");
    return `- ${title}${meta ? ` (${meta})` : ""}${link ? ` — ${link}` : ""}`;
  });

  return [
    "Bronnen:",
    lines.length ? lines.join("\n") : "- (geen bronnen)"
  ].join("\n");
}

function stripSourcesFromAnswer(answer) {
  // FIX: need double escaping in JS string for regex \s
  const a = (answer || "").trim();
  if (!a) return a;

  // remove everything from first "Bronnen:" (or "Sources:") onwards
  const m = a.match(/\b(bronnen|sources)\s*:\s*/i);
  if (!m) return a;
  const idx = m.index ?? -1;
  if (idx >= 0) return a.slice(0, idx).trim();
  return a;
}

function hasCoreSections(answer) {
  const a = (answer || "").toLowerCase();
  return a.includes("antwoord:") && a.includes("toelichting:");
}

function extractSection(answer, header) {
  const re = new RegExp(`${header}:\\s*([\\s\\S]*?)(\\n\\s*[A-Za-zÀ-ÿ]+\\s*:\\s*|$)`, "i");
  const m = (answer || "").match(re);
  return (m?.[1] || "").trim();
}

function extractBewijsquoteFromToelichting(toelichting) {
  const m = (toelichting || "").match(/bewijsquote\s*:\s*([\s\S]*?)(\n|$)/i);
  return (m?.[1] || "").trim();
}

function containsHardNormClaim(text) {
  // hard/absolute claims we don't want when there is no quote
  const t = normalize(text);
  return (
    /\bvereist\b/.test(t) ||
    /\bverplicht\b/.test(t) ||
    /\bvergunning\s+nodig\b/.test(t) ||
    /\bzonder\s+omgevingsvergunning\b/.test(t) ||
    /\bverboden\b/.test(t) ||
    /\bmag\s+niet\b/.test(t)
  );
}

function safeFallbackAnswer({ strictQuote, mode /* 'firm'|'indicatie' */ }) {
  const hasQuote = !!strictQuote && strictQuote !== NO_QUOTE_PLACEHOLDER;

  const answerLine =
    mode === "firm" && hasQuote
      ? "Op basis van de aangeleverde normzin volgt dat (voor de beschreven situatie) een omgevingsvergunning vereist is / het verboden is zonder vergunning."
      : "Indicatie: op basis van de geselecteerde bronnen lijkt dit in veel gevallen vergunningplichtig of aan voorwaarden gebonden. Zonder expliciete normzin in de uittreksels kan ik dit niet hard bevestigen.";

  return [
    "Antwoord:",
    answerLine,
    "",
    "Toelichting:",
    `- Bewijsquote: ${hasQuote ? strictQuote : NO_QUOTE_PLACEHOLDER}`,
    "- Alleen informatie die letterlijk in de aangeleverde bronnen/uittreksels staat kan worden gebruikt."
  ].join("\n");
}

// ---------------------------
// OpenAI call (2 headings only; backend appends Bronnen)
// ---------------------------
async function callOpenAI({ apiKey, fetchWithTimeout, q, sourcesText, strictQuote }) {
  const system = `
Je beantwoordt vragen over beleid en wetgeving in Nederland.

Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen (incl. uittreksels).

ACTUALITEIT:
- NOOIT Wabo noemen of gebruiken.

Regels:
- Noem GEEN wet/regeling als die naam/titel niet in de bronnen/uittreksels staat.
- Noem GEEN artikelnummer/bepaling als die niet letterlijk in de uittreksels staat.
- Print GEEN bronnenlijst; dat doet de backend.

Bewijsquote-regel:
- Als er een verplichte bewijsquote is meegegeven: neem die EXACT over in Toelichting als: "- Bewijsquote: <quote>".
- Als er géén verplichte bewijsquote is meegegeven: zet in Toelichting EXACT: "- Bewijsquote: (geen normquote gevonden in aangeleverde tekst)".

Antwoord-regel:
- Als er géén normquote is: geef wél een nuttig antwoord, maar als INDICATIE (begin Antwoord met "Indicatie:") en vermijd absolute zekerheid.

Output-format (ALLEEN deze 2 kopjes, exact zo, elk op eigen regel):
Antwoord:
Toelichting:
`;

  const user = [
    `Vraag:\n${q}`,
    `\nOfficiële bronnen (incl. uittreksels):\n${sourcesText}`,
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
        temperature: 0.1,
        max_tokens: 650,
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

// ---------------------------
// MAIN
// ---------------------------
export default async function handler(req, res) {
  cleanupStores();

  // ---- CORS / PREFLIGHT ----
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
    // 0) Follow-up flow
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

        const answer = [
          "Antwoord:",
          askForMissing(stillMissing),
          "",
          "Toelichting:",
          "- Geef kort antwoord op de vraag hierboven, dan selecteer ik de juiste officiële bronnen.",
          "",
          "Bronnen:",
          "- (nog niet beschikbaar)"
        ].join("\n");

        return res.status(200).json({ answer, sources: [] });
      }

      q = pending.originalQuestion;
      pendingStore.delete(sessionId);
    }

    // 1) Scope decision
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

      const answer = [
        "Antwoord:",
        askForMissing(need),
        "",
        "Toelichting:",
        "- Voor gemeentelijke regels heb ik minimaal de gemeente nodig.",
        "",
        "Bronnen:",
        "- (nog niet beschikbaar)"
      ].join("\n");

      return res.status(200).json({ answer, sources: [] });
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

      const answer = [
        "Antwoord:",
        questionForSlot("topic_hint"),
        "",
        "Toelichting:",
        "- Met een kernbegrip kan ik de juiste landelijke bron selecteren.",
        "",
        "Bronnen:",
        "- (nog niet beschikbaar)"
      ].join("\n");

      return res.status(200).json({ answer, sources: [] });
    }

    // 2) Search sources
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
        qLc.includes("tijdelijk afwijken") ||
        qLc.includes("tijdelijk");

      sources = await bwbSearchSmart({ q: topicText, fetchWithTimeout, forceOw });
    }

    sources = removeBanned(dedupeByLink(sources));
    sources = rankSources({ sources, q: topicText, scope })
      .slice(0, MAX_SOURCES_RETURN)
      .map(({ _score, ...s }) => s);

    if (!sources.length) {
      const answer = [
        "Antwoord:",
        "Geen officiële bronnen gevonden. Formuleer specifieker met kernbegrippen (en bij gemeentelijke vragen: de gemeente).",
        "",
        "Toelichting:",
        "- Tip: noem het onderwerp (bv. bouwen/milieu/handhaving) en de activiteit (bv. kappen, bouwen, evenement).",
        "",
        "Bronnen:",
        "- (geen bronnen)"
      ].join("\n");

      return res.status(200).json({ answer, sources: [] });
    }

    // 3) Build excerpts + optional strictQuote
    let owNorm = { section: null, quote: null };
    const needsOwNorm =
      scope === "national" &&
      (qLc.includes("omgevingsplan") || qLc.includes("omgevingsvergunning") || qLc.includes("bopa") || qLc.includes("afwijken") || qLc.includes("tijdelijk"));

    if (needsOwNorm) {
      try {
        owNorm = await fetchOmgevingswetNorm(fetchWithTimeout);
      } catch {
        owNorm = { section: null, quote: null };
      }
    }

    // Municipal enrich: fetch excerpt for top 2 sources (so we actually have content)
    let municipalEnrich = {};
    if (scope === "municipal") {
      const kw = ["vergunning", "toestemming", "verboden", "verplicht", "terras", "terrassen", "apv"].concat(extractQueryTerms(topicText));
      for (const s of sources.slice(0, 2)) {
        municipalEnrich[s.link] = await fetchMunicipalExcerpt({ url: s.link, fetchWithTimeout, keywords: kw });
      }
    }

    const sourcesText = sources
      .map((s, i) => {
        const head = `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}`;
        const isOw = (s.id || "").toUpperCase() === OMGEVINGSWET_ID || normalize(s.title) === "omgevingswet";

        if (isOw && owNorm.section) return `${head}\n\nUittreksel (relevant):\n${owNorm.section}`;

        if (scope === "municipal") {
          const ex = municipalEnrich[s.link];
          if (ex?.excerpt) {
            const cand = ex.quote ? `\n\nMogelijke normzin (kandidaat):\n${ex.quote}` : "";
            return `${head}\n\nUittreksel (relevant):\n${ex.excerpt}${cand}`;
          }
        }

        return head;
      })
      .join("\n\n---\n\n");

    // 4) Generate answer
    let answer = await callOpenAI({
      apiKey,
      fetchWithTimeout,
      q: `${q}${scope === "municipal" && collected.municipality ? ` (Gemeente: ${collected.municipality})` : ""}`,
      sourcesText,
      strictQuote: owNorm.quote // null if not found
    });

    // 5) Post-validation
    answer = stripSourcesFromAnswer(answer); // prevent duplicate Bronnen sections

    const ansLc = normalize(answer);
    if (ansLc.includes("wabo") || ansLc.includes("wet algemene bepalingen omgevingsrecht")) {
      answer = safeFallbackAnswer({ strictQuote: owNorm.quote || NO_QUOTE_PLACEHOLDER, mode: owNorm.quote ? "firm" : "indicatie" });
    }

    if (!hasCoreSections(answer)) {
      answer = safeFallbackAnswer({ strictQuote: owNorm.quote || NO_QUOTE_PLACEHOLDER, mode: owNorm.quote ? "firm" : "indicatie" });
    }

    const toelichting = extractSection(answer, "Toelichting");
    const bewijsquote = extractBewijsquoteFromToelichting(toelichting);
    const hasQuote = !!owNorm.quote;

    // Enforce quote rule
    if (hasQuote && !answer.includes(owNorm.quote)) {
      answer = safeFallbackAnswer({ strictQuote: owNorm.quote, mode: "firm" });
    }
    if (!hasQuote && normalize(bewijsquote) !== normalize(NO_QUOTE_PLACEHOLDER)) {
      answer = safeFallbackAnswer({ strictQuote: NO_QUOTE_PLACEHOLDER, mode: "indicatie" });
    }

    // If no quote, enforce Indicatie and block hard norm-claims
    if (!hasQuote) {
      const ant = extractSection(answer, "Antwoord");
      const antLc = normalize(ant);

      if (!antLc.startsWith("indicatie:")) {
        answer = safeFallbackAnswer({ strictQuote: NO_QUOTE_PLACEHOLDER, mode: "indicatie" });
      } else {
        // if it still contains hard norm claims, fallback to safer indicative text
        if (containsHardNormClaim(ant) && !antLc.includes("kan ik dit niet hard bevestigen")) {
          answer = safeFallbackAnswer({ strictQuote: NO_QUOTE_PLACEHOLDER, mode: "indicatie" });
        }
      }
    }

    // 6) Append Bronnen (backend authoritative)
    const safeSources = removeBanned(sources).slice(0, MAX_SOURCES_RETURN);
    const sourcesBlock = formatSourcesBlock(safeSources);

    let final = answer.trim();
    if (!final.toLowerCase().includes("antwoord:") || !final.toLowerCase().includes("toelichting:")) {
      final = safeFallbackAnswer({ strictQuote: owNorm.quote || NO_QUOTE_PLACEHOLDER, mode: owNorm.quote ? "firm" : "indicatie" });
    }

    final = `${final}\n\n${sourcesBlock}`;

    return res.status(200).json({ answer: final, sources: safeSources });
  } catch {
    return res.status(500).json({ error: "Interne fout" });
  }
}
