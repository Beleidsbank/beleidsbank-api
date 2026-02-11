Kort wat er gebeurt en wat ik doe:

* **Wat er gebeurt:** je BWB-zoeklaag levert nu **0 resultaten** op, omdat de query/filters te streng of (deels) op verkeerde SRU-velden zitten. Daardoor krijg je: *“Geen officiële bronnen gevonden…”* terwijl er wél actuele bronnen bestaan (Omgevingswet-stelsel).
* **Wat ik doe:** ik maak BWB-search “hard correct” door **altijd op geldigheidsdatum (vandaag)** te filteren (dus alleen geldende toestanden), én ik zet een **2-pass strategie** neer:

  1. eerst expliciet **Omgevingswet/Bbl/Bkl/Bal/Omgevingsbesluit** ophalen (op geldigheidsdatum)
  2. daarna pas generiek zoeken (ook op geldigheidsdatum)
     En: **Wabo wordt onvoorwaardelijk geblokkeerd** (ID + titel), zodat die nooit kan terugkomen.

Hier is de volledige `chat.js` (drop-in) met die fix:

```js
const rateStore = new Map();
const pendingStore = new Map();
// sessionId -> { originalQuestion, missingSlots:[], collected:{}, createdAt, attempts }

function rateLimit(ip, limit = 10, windowMs = 60000) {
  const now = Date.now();
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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function buildCqlFromTerms(terms = []) {
  const clean = (terms || [])
    .map(t => String(t).trim())
    .filter(t => t.length >= 2)
    .slice(0, 12);

  if (!clean.length) return `keyword all ""`;
  return clean.map(t => `keyword all "${t.replaceAll('"', "")}"`).join(" OR ");
}

/* ================================
   ACTUALITY: NL date (Europe/Amsterdam)
================================ */
function todayNL() {
  // "sv-SE" gives YYYY-MM-DD
  try {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/* ================================
   ABSOLUTE BAN: WABO must never show
================================ */
const BANNED_BWBR_IDS = new Set([
  "BWBR0047270" // Wabo (as observed)
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

/* ================================
   Actuality boost: prefer Omgevingswet-stelsel
================================ */
function actualLawBoostByTitle(title) {
  const t = normalize(title || "");
  let boost = 0;

  if (t.includes("omgevingswet")) boost += 10;
  if (t.includes("besluit bouwwerken leefomgeving")) boost += 9; // Bbl
  if (t.includes("besluit kwaliteit leefomgeving")) boost += 9;  // Bkl
  if (t.includes("besluit activiteiten leefomgeving")) boost += 8; // Bal
  if (t.includes("omgevingsbesluit")) boost += 8;
  if (t.includes("invoeringswet omgevingswet")) boost += 6;

  if (t.includes("omgevingsplan")) boost += 3;
  if (t.includes("buitenplanse")) boost += 3;
  if (t.includes("bouwactiviteit")) boost += 2;
  if (t.includes("omgevingsvergunning")) boost += 2;

  return boost;
}

/* ================================
   Follow-up prompts (no vague loops)
================================ */
function questionForSlot(slot) {
  if (slot === "municipality") return "Voor welke gemeente geldt dit?";
  if (slot === "terrace_type") return "Wat voor soort terras wilt u realiseren? (bijv. bij restaurant, tijdelijk, op stoep/plein)";
  if (slot === "location_hint") return "Heeft u een specifieke locatie in gedachten? (bijv. straat/gebied, of ‘op eigen terrein’ / ‘openbare ruimte’)";
  return "Kunt u dit iets specifieker maken?";
}

function askForMissing(missingSlots) {
  const slots = (missingSlots || []).filter(Boolean);
  if (!slots.length) return null;
  if (slots.length === 1) return questionForSlot(slots[0]);
  const two = slots.slice(0, 2).map(questionForSlot);
  return `Ik heb nog ${two.length} korte vragen:\n- ${two.join("\n- ")}`;
}

function hasMeaningfulDetail(s) {
  const t = (s || "").trim();
  if (!t) return false;
  if (t.length < 3) return false;
  const lc = normalize(t);
  const badExact = new Set(["?", "??", "geen idee", "weet ik niet", "idk", "organisatie?", "organisatie", "context", "wat is dit", "geen"]);
  if (badExact.has(lc)) return false;
  if (lc.includes("geen idee") || lc.includes("weet ik niet")) return false;
  return true;
}

/* ================================
   AI: analyze (with known context)
================================ */
async function analyzeQuestionWithAI({ q, known, apiKey, fetchWithTimeout }) {
  const prompt = `
Analyseer een vraag over Nederlandse wet- en regelgeving. Geef GEEN inhoudelijk antwoord.

Bekende context:
${JSON.stringify(known || {}, null, 2)}

Geef JSON met:
- scope: "municipal" | "national" | "unknown"
- municipality: string|null
- query_terms: array<string> (3-10)
- include_terms: array<string> (0-10)
- exclude_terms: array<string> (0-15)
- is_too_vague: boolean
- missing_slots: array<string> (alleen uit: ["municipality","terrace_type","location_hint"])

Belangrijk:
- Gebruik het actuele stelsel (Omgevingswet). Noem Wabo niet.
- Stel missing_slots alleen als echt nodig voor bronselectie.

Vraag:
"""${q}"""
`;

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 420,
        messages: [
          { role: "system", content: "Output ALLEEN geldige JSON." },
          { role: "user", content: prompt }
        ]
      })
    },
    15000
  );

  const raw = await resp.text();
  const arr = (x) => (Array.isArray(x) ? x.filter(Boolean).map(String) : []);

  try {
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content?.trim();
    const data = JSON.parse(content);

    const scope = ["municipal", "national", "unknown"].includes(data.scope) ? data.scope : "unknown";
    const municipality = data.municipality ? String(data.municipality).trim() : (known?.municipality || null);

    const allowedSlots = new Set(["municipality", "terrace_type", "location_hint"]);
    let missing = arr(data.missing_slots).filter(s => allowedSlots.has(s));
    if (municipality) missing = missing.filter(s => s !== "municipality");

    return {
      scope,
      municipality,
      query_terms: arr(data.query_terms).slice(0, 12),
      include_terms: arr(data.include_terms).slice(0, 12),
      exclude_terms: arr(data.exclude_terms).slice(0, 20),
      is_too_vague: !!data.is_too_vague,
      missing_slots: missing
    };
  } catch {
    return {
      scope: "unknown",
      municipality: known?.municipality || null,
      query_terms: q.split(/\s+/).filter(Boolean).slice(0, 8),
      include_terms: [],
      exclude_terms: [],
      is_too_vague: q.trim().length < 18,
      missing_slots: []
    };
  }
}

/* ================================
   AI: extract slots from follow-up answer
================================ */
async function extractSlotsWithAI({ userText, missingSlots, apiKey, fetchWithTimeout }) {
  const prompt = `
Extraheer ALLEEN deze velden uit het antwoord en geef JSON. Geen extra velden.
Slots: ${JSON.stringify(missingSlots)}

Definities:
- municipality: alleen gemeentenaam (bv. "Amsterdam")
- terrace_type: korte omschrijving
- location_hint: korte locatie-indicatie

Als iets niet duidelijk is: null.

Antwoord:
"""${userText}"""
`;

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: "Output ALLEEN geldige JSON." },
          { role: "user", content: prompt }
        ]
      })
    },
    12000
  );

  const raw = await resp.text();
  try {
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content?.trim();
    const data = JSON.parse(content);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/* ================================
   Scoring / ranking
================================ */
function scoreSources({ sources, q, queryTerms, includeTerms, excludeTerms, scope }) {
  const qLc = normalize(q);
  const pos = [...new Set([...queryTerms, ...includeTerms].map(normalize).filter(Boolean))];
  const neg = [...new Set((excludeTerms || []).map(normalize).filter(Boolean))].filter(t => t && !qLc.includes(t));

  const typeBoost = (type) => {
    if (scope === "municipal") {
      if (type === "CVDR") return 3.0;
      if ((type || "").toLowerCase().includes("gemeenteblad")) return 1.5;
    }
    if (scope === "national") {
      if (type === "BWB") return 2.5;
    }
    return 0.5;
  };

  function scoreOne(s) {
    if (isBannedSource(s)) return -9999;

    const title = normalize(s?.title || "");
    let score = 0;

    for (const t of pos) if (t && title.includes(t)) score += 2.0;

    const qWords = qLc.split(/\s+/).filter(w => w.length >= 5).slice(0, 10);
    for (const w of qWords) if (title.includes(w)) score += 0.6;

    for (const t of neg) if (title.includes(t)) score -= 2.5;

    score += actualLawBoostByTitle(s.title);
    score += typeBoost(s.type);
    return score;
  }

  const scored = (sources || []).map(s => ({ ...s, _score: scoreOne(s) }));
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  return scored.filter(x => x._score > -9990);
}

function computeConfidence(scoredSources) {
  if (!scoredSources?.length) return 0;
  const top = scoredSources[0]?._score ?? 0;
  const second = scoredSources[1]?._score ?? 0;
  const gap = top - second;
  return clamp((top / 8) + (gap / 4), 0, 1);
}

/* ================================
   SRU search: CVDR / OEP
================================ */
async function cvdrSearch({ municipalityName, cqlTopic, fetchWithTimeout }) {
  const base = "https://zoekdienst.overheid.nl/sru/Search";
  const creatorsToTry = [
    municipalityName,
    `Gemeente ${municipalityName}`,
    `gemeente ${municipalityName}`
  ];

  for (const creator of creatorsToTry) {
    const cql = `(dcterms.creator="${creator}") AND (${cqlTopic})`;

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

    const uniq = dedupeByLink(items);
    if (uniq.length) return uniq;
  }
  return [];
}

async function oepSearch({ municipalityName, cqlTopic, fetchWithTimeout }) {
  const base = "https://zoek.officielebekendmakingen.nl/sru/Search";
  const cql = `publicatieNaam="Gemeenteblad" AND (${cqlTopic}) AND (keyword all "${municipalityName}")`;

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

  return dedupeByLink(items);
}

/* ================================
   BWB SRU (ACTUAL + WORKING)
   Key fix:
   - Filter on overheidbwb.geldigheidsdatum = todayNL()
     (documented as a valid request field)
   - Use dcterms.title as primary title (documented in response)
   - Prefer Omgevingswet-stelsel first, then generic
================================ */
async function bwbSearchActual({ q, preferOmgevingsStelsel, fetchWithTimeout }) {
  const base = "https://zoekservice.overheid.nl/sru/Search";
  const gd = todayNL(); // YYYY-MM-DD

  const run = async (cql) => {
    const url =
      `${base}?version=1.2&operation=searchRetrieve&x-connection=BWB` +
      `&maximumRecords=25&startRecord=1` +
      `&query=${encodeURIComponent(cql)}`;

    const resp = await fetchWithTimeout(url, {}, 15000);
    const xml = await resp.text();

    const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);

    // Response field is documented as dcterms:title; keep fallback for older tag names.
    const titlesA = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);
    const titlesB = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);
    const titles = titlesA.length ? titlesA : titlesB;

    let items = dedupeByLink(ids.map((id, i) => ({
      id,
      title: titles[i] || id,
      link: `https://wetten.overheid.nl/${id}`,
      type: "BWB"
    })));

    return removeBanned(items);
  };

  // Always exclude WABO by identifier (double safety)
  const NOT_WABO = `NOT dcterms.identifier="BWBR0047270"`;

  // IMPORTANT: ensure “geldige toestand op datum” -> only current law state
  const ON_DATE = `overheidbwb.geldigheidsdatum="${gd}"`;

  if (preferOmgevingsStelsel) {
    const preferred = [
      `overheidbwb.titel any "Omgevingswet"`,
      `overheidbwb.titel any "Omgevingsbesluit"`,
      `overheidbwb.titel any "Besluit bouwwerken leefomgeving"`,
      `overheidbwb.titel any "Besluit kwaliteit leefomgeving"`,
      `overheidbwb.titel any "Besluit activiteiten leefomgeving"`,
      `overheidbwb.titel any "Invoeringswet Omgevingswet"`
    ].join(" OR ");

    const cql1 = `(${preferred}) AND ${ON_DATE} AND ${NOT_WABO}`;
    const res1 = await run(cql1);
    if (res1.length) return res1;
  }

  // Generic: use title any query but still on geldigheidsdatum
  const safeQ = q.replaceAll('"', "");
  const cql2 = `(overheidbwb.titel any "${safeQ}") AND ${ON_DATE} AND ${NOT_WABO}`;
  const res2 = await run(cql2);
  if (res2.length) return res2;

  // Broader fallback: split keywords
  const words = normalize(q).split(/\s+/).filter(w => w.length >= 6).slice(0, 6);
  if (words.length) {
    const cql3 = `(${words.map(w => `overheidbwb.titel any "${w}"`).join(" OR ")}) AND ${ON_DATE} AND ${NOT_WABO}`;
    const res3 = await run(cql3);
    if (res3.length) return res3;
  }

  return [];
}

/* ================================
   MAIN HANDLER
================================ */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://app.beleidsbank.nl");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

  const fetchWithTimeout = async (url, options = {}, ms = 15000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

  try {
    // -----------------------------
    // 0) Slot filling
    // -----------------------------
    let known = {};

    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (Date.now() - pending.createdAt) < 7 * 60 * 1000;

    if (fresh) {
      const missingSlots = pending.missingSlots || [];
      const collected = pending.collected || {};
      const attempts = Number.isFinite(pending.attempts) ? pending.attempts : 0;
      const MAX_ATTEMPTS = 3;

      const extracted = await extractSlotsWithAI({
        userText: q,
        missingSlots,
        apiKey,
        fetchWithTimeout
      });

      if (missingSlots.includes("municipality") && !extracted?.municipality && looksLikeMunicipality(q)) {
        extracted.municipality = q.trim();
      }
      if (missingSlots.includes("terrace_type") && !extracted?.terrace_type && hasMeaningfulDetail(q)) {
        extracted.terrace_type = q.trim();
      }
      if (missingSlots.includes("location_hint") && !extracted?.location_hint && hasMeaningfulDetail(q)) {
        extracted.location_hint = q.trim();
      }

      if (missingSlots.includes("municipality") && extracted?.municipality) collected.municipality = String(extracted.municipality).trim();
      if (missingSlots.includes("terrace_type") && extracted?.terrace_type) collected.terrace_type = String(extracted.terrace_type).trim();
      if (missingSlots.includes("location_hint") && extracted?.location_hint) collected.location_hint = String(extracted.location_hint).trim();

      const stillMissing = [];
      if (missingSlots.includes("municipality") && !collected.municipality) stillMissing.push("municipality");
      if (missingSlots.includes("terrace_type") && !collected.terrace_type) stillMissing.push("terrace_type");
      if (missingSlots.includes("location_hint") && !collected.location_hint) stillMissing.push("location_hint");

      if (stillMissing.length && attempts < MAX_ATTEMPTS) {
        pending.missingSlots = stillMissing;
        pending.collected = collected;
        pending.attempts = attempts + 1;
        pendingStore.set(sessionId, pending);
        return res.status(200).json({ answer: askForMissing(stillMissing), sources: [] });
      }

      known = { ...collected };
      q = pending.originalQuestion;
      pendingStore.delete(sessionId);
    }

    // -----------------------------
    // 1) AI analysis
    // -----------------------------
    const analysis = await analyzeQuestionWithAI({
      q,
      known,
      apiKey,
      fetchWithTimeout
    });

    const scope = analysis.scope;
    const municipality = analysis.municipality || known.municipality || null;

    // -----------------------------
    // 2) Missing slots only where it matters (terraces)
    // -----------------------------
    const qLc = normalize(q);
    const mentionsTerras = qLc.includes("terras") || qLc.includes("terrassen");
    let missingSlots = [];

    if (scope === "municipal" && !municipality) missingSlots.push("municipality");

    const terraceTypeKnown = !!(known.terrace_type && hasMeaningfulDetail(known.terrace_type));
    const locationKnown = !!(known.location_hint && hasMeaningfulDetail(known.location_hint));

    if (scope === "municipal" && mentionsTerras) {
      if (!terraceTypeKnown) missingSlots.push("terrace_type");
      const veryShort = q.trim().split(/\s+/).filter(Boolean).length <= 4;
      if (veryShort && !locationKnown) missingSlots.push("location_hint");
    }

    const haveEnoughForTerras =
      scope === "municipal" && mentionsTerras && municipality && (terraceTypeKnown || hasMeaningfulDetail(q));

    if (!haveEnoughForTerras && missingSlots.length) {
      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots,
          collected: { ...known, ...(municipality ? { municipality } : {}) },
          createdAt: Date.now(),
          attempts: 0
        });
      }
      return res.status(200).json({ answer: askForMissing(missingSlots), sources: [] });
    }

    // -----------------------------
    // 3) Build terms
    // -----------------------------
    const terms = [...analysis.query_terms, ...analysis.include_terms];
    if (known.terrace_type && hasMeaningfulDetail(known.terrace_type)) terms.push(known.terrace_type);
    if (known.location_hint && hasMeaningfulDetail(known.location_hint)) terms.push(known.location_hint);
    if (municipality) terms.push(municipality);

    const likelyOmgevingswet =
      qLc.includes("omgevingsplan") ||
      qLc.includes("buitenplanse") ||
      qLc.includes("bouwactiviteit") ||
      qLc.includes("omgevingsvergunning") ||
      qLc.includes("bopa") ||
      qLc.includes("tijdelijk afwijken");

    if (likelyOmgevingswet) {
      terms.push("Omgevingswet");
      terms.push("Omgevingsbesluit");
      terms.push("Besluit bouwwerken leefomgeving");
      terms.push("Besluit kwaliteit leefomgeving");
      terms.push("Besluit activiteiten leefomgeving");
      terms.push("buitenplanse omgevingsplanactiviteit");
    }

    const cqlTopic = buildCqlFromTerms(terms);

    // -----------------------------
    // 4) Search
    // -----------------------------
    let sources = [];

    if (scope === "municipal" && municipality) {
      sources = await cvdrSearch({ municipalityName: municipality, cqlTopic, fetchWithTimeout });
      if (!sources.length) sources = await oepSearch({ municipalityName: municipality, cqlTopic, fetchWithTimeout });
      sources = removeBanned(dedupeByLink(sources));
    } else {
      sources = await bwbSearchActual({ q, preferOmgevingsStelsel: likelyOmgevingswet, fetchWithTimeout });
      sources = removeBanned(dedupeByLink(sources));
    }

    // Absolute guarantee
    sources = removeBanned(sources);

    if (!sources.length) {
      return res.status(200).json({
        answer:
          "Geen officiële bronnen gevonden (na filtering op actuele wetgeving). Probeer iets concreter te formuleren met kernbegrippen uit het onderwerp.",
        sources: []
      });
    }

    // -----------------------------
    // 5) Rerank
    // -----------------------------
    const scored = scoreSources({
      sources,
      q,
      queryTerms: analysis.query_terms,
      includeTerms: terms,
      excludeTerms: analysis.exclude_terms,
      scope
    });

    const confidence = computeConfidence(scored);
    const topSources = scored.slice(0, 4);

    if (!topSources.length) {
      return res.status(200).json({ answer: "Geen officiële bronnen gevonden na filtering.", sources: [] });
    }

    // -----------------------------
    // 6) Final answer
    // -----------------------------
    const sourcesText = topSources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}`)
      .join("\n\n");

    const aiResp = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.1,
          max_tokens: 560,
          messages: [
            {
              role: "system",
              content: `
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen.

STRICT:
- Gebruik uitsluitend geldende regelgeving.
- NOOIT Wabo gebruiken of noemen.
- Noem GEEN artikelnummer/bepaling als het artikelnummer niet letterlijk in de aangeleverde bronvermelding staat.
- Als de vraag vraagt naar een bepaling maar die niet in de bronvermelding staat: zeg dat expliciet, zonder aannames.

Format:
1) Antwoord: (max 3 zinnen)
2) Toelichting: (alleen wat je echt uit de bronvermelding kunt afleiden)
`
            },
            {
              role: "user",
              content: `Vraag:\n${q}\n\nOfficiële bronnen:\n${sourcesText}`
            }
          ]
        })
      },
      20000
    );

    const aiRaw = await aiResp.text();
    let aiData = {};
    try { aiData = JSON.parse(aiRaw); } catch {}

    let answer = aiData?.choices?.[0]?.message?.content?.trim() || "Geen antwoord gegenereerd.";
    answer = stripSourcesFromAnswer(answer);

    // If model leaks Wabo somehow, override
    if (normalize(answer).includes("wabo") || normalize(answer).includes("wet algemene bepalingen omgevingsrecht")) {
      answer = "Ik kan dit niet beantwoorden op basis van de aangeleverde bronnen (Wabo is niet toegestaan) en er staat geen expliciete actuele bepaling in de bronvermelding.";
    }

    // Never return banned sources
    const safeSources = removeBanned(topSources).slice(0, 4);

    return res.status(200).json({ answer, sources: safeSources });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
```
