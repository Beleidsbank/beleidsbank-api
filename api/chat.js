// /api/chat.js — Beleidsbank V1 (Optie A: altijd antwoord, geen hallucinatie-artikelen) — V2-ready
//
// Response JSON:
// { answer: "Antwoord:\n...\n\nToelichting:\n...", sources: [{title,link,type,id}] }
//
// Key rules:
// - Always provide a helpful answer.
// - Never cite article numbers unless present in provided excerpts.
// - Municipal questions: give a general answer + ask municipality (session follow-up).
// - Hard ban Wabo.
// - Model must not print sources; frontend renders sources[].

const rateStore = new Map();
const pendingStore = new Map(); // sessionId -> { originalQuestion, missingSlots:[], collected:{}, createdAt, attempts }
const cacheStore = new Map();   // key -> { value, expiresAt }

const MAX_SOURCES_RETURN = 4;
const MAX_EXCERPTS_FETCH = 2; // keep it light and stable
const OMGEVINGSWET_ID = "BWBR0037885";

// ---------------------------
// Basics
// ---------------------------
function nowMs() { return Date.now(); }

function cleanupStores() {
  const now = nowMs();

  // pendingStore: expire after 10 minutes
  for (const [k, v] of pendingStore.entries()) {
    const createdAt = Number(v?.createdAt || 0);
    if (!createdAt || (now - createdAt) > 10 * 60 * 1000) pendingStore.delete(k);
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

function rateLimit(ip, limit = 20, windowMs = 60000) {
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
  const badExact = new Set(["?", "??", "???", "geen idee", "weet ik niet", "idk", "geen", "nvt", "help"]);
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
// Hard bans (Wabo never)
// ---------------------------
const BANNED_BWBR_IDS = new Set([
  "BWBR0024779", // Wabo
  "BWBR0047270"
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
// Follow-up slots (V1 minimal)
// ---------------------------
const ALLOWED_SLOTS = ["municipality"];
function questionForSlot(slot) {
  if (slot === "municipality") return "Voor welke gemeente geldt dit?";
  return "Kunt u dit iets specifieker maken?";
}

// ---------------------------
// Scope detection
// ---------------------------
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
    qLc.includes("havenverordening")
  );
}

function decideScope(q) {
  const qLc = normalize(q);
  if (isExplicitMunicipalTopic(qLc)) return "municipal";
  return "national";
}

// ---------------------------
// Term extraction (light)
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

// National: always prefer core stelsel if question looks OW-ish
async function bwbSearchSmart({ q, fetchWithTimeout }) {
  const qLc = normalize(q);

  const looksOw =
    qLc.includes("omgevingsplan") ||
    qLc.includes("omgevingsvergunning") ||
    qLc.includes("bopa") ||
    qLc.includes("omgevingsplanactiviteit") ||
    qLc.includes("bouwactiviteit") ||
    qLc.includes("bal") ||
    qLc.includes("bbl") ||
    qLc.includes("bkl") ||
    qLc.includes("omgevingsbesluit") ||
    qLc.includes("afwijken");

  if (looksOw) {
    const core = [
      `overheidbwb.titel any "Omgevingswet"`,
      `overheidbwb.titel any "Besluit bouwwerken leefomgeving"`,
      `overheidbwb.titel any "Besluit activiteiten leefomgeving"`,
      `overheidbwb.titel any "Besluit kwaliteit leefomgeving"`,
      `overheidbwb.titel any "Omgevingsbesluit"`
    ].join(" OR ");

    let items = await bwbSruSearch({ cql: `(${core})`, fetchWithTimeout, max: 25 });

    // Ensure Omgevingswet always present
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

  // fallback: try terms search by title
  const terms = extractQueryTerms(q).slice(0, 6);
  if (terms.length) {
    const cql = terms.map(t => `overheidbwb.titel any "${t.replaceAll('"', "")}"`).join(" OR ");
    const items = await bwbSruSearch({ cql, fetchWithTimeout, max: 25 });
    if (items.length) return items;
  }

  // as last resort: Omgevingswet only
  return [{
    id: OMGEVINGSWET_ID,
    title: "Omgevingswet",
    link: `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`,
    type: "BWB"
  }];
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
    if (s.type === "CVDR") score += 10;
  } else {
    if (s.type === "BWB") score += 5;
  }

  // Core stelsel boost
  if ((s.id || "").toUpperCase() === OMGEVINGSWET_ID) score += 100;
  if (title.includes("besluit bouwwerken leefomgeving")) score += 50;
  if (title.includes("besluit activiteiten leefomgeving")) score += 45;
  if (title.includes("omgevingsbesluit")) score += 40;
  if (title.includes("besluit kwaliteit leefomgeving")) score += 35;

  // Deprioritize noisy “wijzig/aanvullings/invoerings/tijdstip”
  if (title.includes("vaststelling tijdstip") || title.includes("bepaling termijn")) score -= 30;
  if (title.includes("aanvullings")) score -= 15;
  if (title.includes("invoerings")) score -= 10;
  if (title.includes("wijzig")) score -= 8;
  if (title.includes("verzamel")) score -= 8;

  // Keyword match
  const terms = extractQueryTerms(q);
  for (const t of terms) if (title.includes(t)) score += 2;

  // Municipal hints
  if (scope === "municipal") {
    if (qLc.includes("terras") && title.includes("terras")) score += 10;
    if (qLc.includes("apv") && title.includes("plaatselijke verordening")) score += 8;
  }

  return score;
}

function rankSources({ sources, q, scope }) {
  const scored = (sources || []).map(s => ({ ...s, _score: scoreSource({ s, q, scope }) }));
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  return scored.filter(x => x._score > -9990);
}

// ---------------------------
// Excerpt fetching (V1: light, best-effort)
// We do NOT aim for perfect parsing; just enough to prevent hallucinated articles.
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

function pickRelevantLines(text, keywords, maxLines = 18) {
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

  if (hits.length) return hits.join("\n");
  return lines.slice(0, Math.min(maxLines, lines.length)).join("\n");
}

// Cache heavy fetches briefly to reduce latency
async function fetchExcerptForSource({ source, q, scope, fetchWithTimeout }) {
  const cacheKey = `ex:${source.id}:${normalize(q).slice(0, 80)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetchWithTimeout(source.link, {}, 15000);
    const html = await resp.text();
    const text = htmlToTextLite(html);

    // Keyword selection based on question
    const qLc = normalize(q);
    let keywords = extractQueryTerms(q);

    // strengthen for key topics
    if (qLc.includes("bopa") || qLc.includes("afwijken")) keywords = [...new Set([...keywords, "omgevingsplan", "afwijken", "vergunning"])];
    if (qLc.includes("terras")) keywords = [...new Set([...keywords, "terras", "vergunning", "verboden", "toestemming"])];

    const excerpt = pickRelevantLines(text, keywords, 18);
    const out = excerpt ? excerpt.slice(0, 2400) : null;

    cacheSet(cacheKey, out, 2 * 60 * 60 * 1000); // 2h
    return out;
  } catch {
    cacheSet(cacheKey, null, 15 * 60 * 1000); // 15m negative cache
    return null;
  }
}

// ---------------------------
// OpenAI call (safe: no article numbers unless in excerpts)
// Always answer, but be cautious when excerpt lacks explicit norm.
// ---------------------------
function stripSourcesFromAnswer(answer) {
  const a = (answer || "").trim();
  if (!a) return a;
  const m = a.match(/\b(bronnen|sources)\b\s*:?\s*/i);
  if (!m) return a;
  const idx = m.index ?? -1;
  if (idx >= 0) return a.slice(0, idx).trim();
  return a;
}

function ensureTwoHeadings(answer) {
  const a = (answer || "").trim();
  const lc = a.toLowerCase();
  if (lc.includes("antwoord:") && lc.includes("toelichting:")) return a;

  return [
    "Antwoord:",
    "Er kon geen goed geformatteerd antwoord worden gegenereerd.",
    "",
    "Toelichting:",
    "- Probeer de vraag iets concreter te maken."
  ].join("\n");
}

async function callOpenAI({ apiKey, fetchWithTimeout, q, sourcesPack, scope, collected }) {
  const system = `
Je beantwoordt vragen over Nederlands beleid en wetgeving.

Je mag ALLEEN concrete verwijzingen (zoals artikelnummer/lid) noemen als die letterlijk in de aangeleverde uittreksels staan.
Als er geen expliciete normzin zichtbaar is in de uittreksels, geef dan wél een praktisch antwoord, maar formuleer voorzichtig (bv. "vaak", "meestal", "hangt af van") en geef aan wat je nodig hebt om het exact te maken.

STRICT:
- NOOIT Wabo noemen of gebruiken.
- Print GEEN bronnen en géén kopje "Bronnen" of "Sources" (frontend toont bronnen).

Output-format (ALLEEN deze twee kopjes):
Antwoord:
Toelichting:
`.trim();

  const contextBits = [];
  if (scope === "municipal" && !collected?.municipality) {
    contextBits.push(
      "Let op: dit is een gemeentelijke vraag. Geef eerst een algemeen antwoord en vraag daarna om de gemeente voor exacte regels."
    );
  }

  const user = [
    `Vraag:\n${q}`,
    contextBits.length ? `\nContext:\n- ${contextBits.join("\n- ")}` : "",
    `\nOfficiële bronnen + uittreksels:\n${sourcesPack}`
  ].join("\n");

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.15,
        max_tokens: 650,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
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

// ---------------------------
// MAIN
// ---------------------------
export default async function handler(req, res) {
  cleanupStores();

  // ---- CORS / OPTIONS ----
  const origin = (req.headers.origin || "").toString();
  const allow = "https://app.beleidsbank.nl";
  res.setHeader("Access-Control-Allow-Origin", origin === allow ? origin : allow);
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

  const { message, session_id } = req.body || {};
  const sessionId = (session_id || "").toString().trim();
  let q = (message || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing message" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt." });

  const fetchWithTimeout = makeFetchWithTimeout();

  try {
    // -----------------------------
    // 0) Follow-up flow (only municipality)
    // -----------------------------
    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (nowMs() - pending.createdAt) < 10 * 60 * 1000;

    let collected = {};
    if (fresh) {
      collected = { ...(pending.collected || {}) };
      const missing = (pending.missingSlots || []).filter(s => ALLOWED_SLOTS.includes(s));
      const attempts = Number.isFinite(pending.attempts) ? pending.attempts : 0;

      if (missing.includes("municipality") && !collected.municipality && looksLikeMunicipality(q)) {
        collected.municipality = q.trim();
      }

      const stillMissing = [];
      if (missing.includes("municipality") && !collected.municipality) stillMissing.push("municipality");

      if (stillMissing.length && attempts < 2) {
        pending.missingSlots = stillMissing;
        pending.collected = collected;
        pending.attempts = attempts + 1;
        pendingStore.set(sessionId, pending);

        // Always answer + ask (Optie A)
        const answer = [
          "Antwoord:",
          "Algemeen: een terras is vaak vergunning- of toestemmingsplichtig op basis van gemeentelijke regels (APV/terrasbeleid).",
          "",
          "Toelichting:",
          `- ${questionForSlot("municipality")}`,
          "- Met de gemeente kan ik de juiste APV/beleidsregel ophalen en het exacte artikel tonen."
        ].join("\n");

        return res.status(200).json({ answer, sources: [] });
      }

      q = pending.originalQuestion;
      pendingStore.delete(sessionId);
    }

    // -----------------------------
    // 1) Scope
    // -----------------------------
    const scope = decideScope(q);
    const qLc = normalize(q);

    // For municipal: if no municipality yet, store pending but still answer generally now.
    if (scope === "municipal" && !collected.municipality) {
      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots: ["municipality"],
          collected: { ...collected },
          createdAt: nowMs(),
          attempts: 0
        });
      }

      const answer = [
        "Antwoord:",
        "Algemeen: een terras is vaak vergunning- of toestemmingsplichtig via gemeentelijke regels (APV/terrasbeleid).",
        "",
        "Toelichting:",
        `- ${questionForSlot("municipality")}`,
        "- Zonder gemeente kan ik geen exacte bepalingen (artikelen) uit de lokale regels tonen."
      ].join("\n");

      return res.status(200).json({ answer, sources: [] });
    }

    // -----------------------------
    // 2) Find sources
    // -----------------------------
    let sources = [];
    if (scope === "municipal") {
      const mun = collected.municipality;
      const topicText = q; // keep simple
      sources = await cvdrSearch({ municipalityName: mun, topicText, fetchWithTimeout });

      // If nothing found, widen search terms a bit
      if (!sources.length) {
        const keyTerms = extractQueryTerms(q).join(" ");
        sources = await cvdrSearch({ municipalityName: mun, topicText: keyTerms || q, fetchWithTimeout });
      }
    } else {
      sources = await bwbSearchSmart({ q, fetchWithTimeout });
    }

    sources = removeBanned(dedupeByLink(sources));
    sources = rankSources({ sources, q, scope }).slice(0, MAX_SOURCES_RETURN).map(({ _score, ...s }) => s);

    // Always return something usable even if sources empty
    const safeSources = removeBanned(sources).slice(0, MAX_SOURCES_RETURN);

    // -----------------------------
    // 3) Fetch excerpts (best-effort, light)
    // -----------------------------
    const excerptSources = safeSources.slice(0, MAX_EXCERPTS_FETCH);
    const excerpts = [];

    for (const s of excerptSources) {
      const ex = await fetchExcerptForSource({ source: s, q, scope, fetchWithTimeout });
      excerpts.push({ source: s, excerpt: ex });
    }

    const sourcesPack = excerpts.map((x, i) => {
      const s = x.source;
      const head = `Bron ${i + 1}: ${s.title}\nType: ${s.type}\nID: ${s.id}\nLink: ${s.link}`;
      const ex = x.excerpt ? `\n\nUittreksel:\n${x.excerpt}` : "\n\nUittreksel:\n(niet opgehaald)";
      return `${head}${ex}`;
    }).join("\n\n---\n\n");

    // -----------------------------
    // 4) Answer (always)
    // -----------------------------
    const ai = await callOpenAI({
      apiKey,
      fetchWithTimeout,
      q: scope === "municipal" && collected.municipality ? `${q} (Gemeente: ${collected.municipality})` : q,
      sourcesPack,
      scope,
      collected
    });

    if (!ai.ok) {
      // Graceful fallback (still an answer)
      const fallback = [
        "Antwoord:",
        "Ik kan nu geen volledig onderbouwd antwoord genereren door een tijdelijke fout, maar algemeen geldt: de exacte regels hangen af van de context en (bij lokale regels) de gemeente.",
        "",
        "Toelichting:",
        "- Probeer het opnieuw of geef extra details (activiteit, locatie, gemeente)."
      ].join("\n");

      return res.status(200).json({ answer: fallback, sources: safeSources });
    }

    let answer = stripSourcesFromAnswer(ai.content);
    answer = ensureTwoHeadings(answer);

    // Extra guardrail: if model still mentions “Bronnen/Sources”, strip again
    if (/\b(bronnen|sources)\b/i.test(answer)) {
      answer = stripSourcesFromAnswer(answer);
      answer = ensureTwoHeadings(answer);
    }

    return res.status(200).json({ answer, sources: safeSources });
  } catch (e) {
    return res.status(500).json({
      error: "Interne fout",
      details: String(e?.stack || e)
    });
  }
}
