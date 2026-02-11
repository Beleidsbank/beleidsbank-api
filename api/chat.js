// /api/chat.js

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

function hasMeaningfulDetail(s) {
  const t = (s || "").trim();
  if (!t) return false;
  if (t.length < 3) return false;
  const lc = normalize(t);
  const badExact = new Set(["?", "??", "geen idee", "weet ik niet", "idk", "geen", "nvt", "organisatie?", "context"]);
  if (badExact.has(lc)) return false;
  if (lc.includes("geen idee") || lc.includes("weet ik niet")) return false;
  return true;
}

/* ================================
   ABSOLUTE BAN: WABO must never show
================================ */
const BANNED_BWBR_IDS = new Set([
  "BWBR0047270", // Wabo (you observed)
  "BWBR0024779"  // Wabo (official id)
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
   Follow-up prompts
================================ */
function questionForSlot(slot) {
  if (slot === "municipality") return "Voor welke gemeente geldt dit?";
  if (slot === "terrace_type") return "Wat voor soort terras bedoelt u? (bijv. bij restaurant, tijdelijk, op stoep/plein, op eigen terrein)";
  if (slot === "location_hint") return "Gaat het om openbare ruimte of eigen terrein? (eventueel straat/gebied)";
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

/* ================================
   Scope detection (fixed)
================================ */
function isLegalBasisQuestion(qLc) {
  return (
    qLc.includes("op grond van welke") ||
    qLc.includes("welke bepaling") ||
    qLc.includes("welk artikel") ||
    qLc.includes("juridische grondslag") ||
    qLc.includes("bevoegdheid") ||
    qLc.includes("grondslag") ||
    qLc.includes("vergunningplicht") ||
    (qLc.includes("vereist") && (qLc.includes("omgevingsvergunning") || qLc.includes("vergunning")))
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
    qLc.includes("horeca") ||
    qLc.includes("sluitingstijden") ||
    qLc.includes("gemeentelijke verordening") ||
    (qLc.includes("beleidsregel") && qLc.includes("gemeente"))
  );
}

function isOmgevingsplanLocalInterpretationQuestion(qLc) {
  return (
    (qLc.includes("wat staat er in") && qLc.includes("omgevingsplan")) ||
    (qLc.includes("regels") && qLc.includes("omgevingsplan") && (qLc.includes("gemeente") || qLc.includes("stadsdeel"))) ||
    (qLc.includes("omgevingsplan") && (qLc.includes("locatie") || qLc.includes("adres") || qLc.includes("gebied") || qLc.includes("perceel"))) ||
    (qLc.includes("omgevingsplan") && qLc.includes("van de gemeente"))
  );
}

function isTerraceQuestion(qLc) {
  return qLc.includes("terras") || qLc.includes("terrassen");
}

function isTooVagueGeneral(q) {
  const words = (q || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= 3) return true;
  if ((q || "").trim().length < 18) return true;
  return false;
}

function decideScope(q) {
  const qLc = normalize(q);

  // Legal basis / permit requirement => NATIONAL (even if municipality mentioned)
  if (isLegalBasisQuestion(qLc)) return "national";

  // Explicit municipal topics => MUNICIPAL
  if (isExplicitMunicipalTopic(qLc)) return "municipal";

  // Omgevingsplan municipal only if question is clearly about the plan’s local contents at a location
  if (isOmgevingsplanLocalInterpretationQuestion(qLc)) return "municipal";

  return "national";
}

/* ================================
   Fetch with timeout
================================ */
function makeFetchWithTimeout() {
  return async (url, options = {}, ms = 12000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };
}

/* ================================
   Extract snippet from wetten.overheid.nl
   - We do this ONLY for Omgevingswet article 5.1 area to enable accurate “which provision”
================================ */
function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|br)>/gi, "\n")
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

function extractAround(text, needle, radius = 1200) {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return text.slice(start, end).trim();
}

async function wettenSnippetOmgevingswetArt51(fetchWithTimeout) {
  const url = "https://wetten.overheid.nl/BWBR0037885";
  const resp = await fetchWithTimeout(url, {}, 12000);
  const html = await resp.text();
  const text = htmlToTextLite(html);

  // Try “Artikel 5.1” first
  let snip = extractAround(text, "Artikel 5.1", 1500);
  if (!snip) snip = extractAround(text, "5.1", 1500);

  // If still nothing, return a small beginning (fallback)
  if (!snip) return text.slice(0, 2000);

  // Keep it small for tokens, but enough for model to cite lid/onderdeel if present
  return snip.slice(0, 2400);
}

/* ================================
   SRU search: CVDR / OEP
================================ */
async function cvdrSearch({ municipalityName, topicWords, fetchWithTimeout }) {
  const base = "https://zoekdienst.overheid.nl/sru/Search";
  const creatorsToTry = [
    municipalityName,
    `Gemeente ${municipalityName}`,
    `gemeente ${municipalityName}`
  ];

  for (const creator of creatorsToTry) {
    const safeTopic = topicWords.replaceAll('"', "");
    const cql = `(dcterms.creator="${creator}") AND (keyword all "${safeTopic}")`;

    const url =
      `${base}?version=1.2` +
      `&operation=searchRetrieve` +
      `&x-connection=cvdr` +
      `&x-info-1-accept=any` +
      `&maximumRecords=25` +
      `&startRecord=1` +
      `&query=${encodeURIComponent(cql)}`;

    const resp = await fetchWithTimeout(url, {}, 12000);
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

async function oepSearch({ municipalityName, topicWords, fetchWithTimeout }) {
  const base = "https://zoek.officielebekendmakingen.nl/sru/Search";
  const safeTopic = topicWords.replaceAll('"', "");
  const cql = `publicatieNaam="Gemeenteblad" AND keyword all "${municipalityName} ${safeTopic}"`;

  const url =
    `${base}?version=1.2` +
    `&operation=searchRetrieve` +
    `&x-connection=oep` +
    `&recordSchema=dc` +
    `&maximumRecords=25` +
    `&startRecord=1` +
    `&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url, {}, 12000);
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

/* ================================
   SRU search: BWB (improved for legal-basis questions)
   - If question is about permit requirement / legal basis for omgevingsplan deviation:
     ALWAYS include Omgevingswet BWBR0037885 as top candidate + snippet.
   - Avoid amendment/noise by prioritizing primary titles.
================================ */
const OMGEVINGSWET_ID = "BWBR0037885";

async function bwbSearch({ q, fetchWithTimeout, forceOmgevingswet }) {
  const base = "https://zoekservice.overheid.nl/sru/Search";
  const safeQ = (q || "").replaceAll('"', "");

  const run = async (cql) => {
    const url =
      `${base}?version=1.2&operation=searchRetrieve&x-connection=BWB` +
      `&maximumRecords=20&startRecord=1` +
      `&query=${encodeURIComponent(cql)}`;

    const resp = await fetchWithTimeout(url, {}, 12000);
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
  };

  // 1) Force primary Omgevingswet and core decrees FIRST (reduces amendments)
  const coreTitles = [
    `overheidbwb.titel any "Omgevingswet"`,
    `overheidbwb.titel any "Omgevingsbesluit"`,
    `overheidbwb.titel any "Besluit bouwwerken leefomgeving"`,
    `overheidbwb.titel any "Besluit kwaliteit leefomgeving"`,
    `overheidbwb.titel any "Besluit activiteiten leefomgeving"`,
    `overheidbwb.titel any "Invoeringswet Omgevingswet"`
  ].join(" OR ");

  const resCore = await run(`(${coreTitles})`);
  if (resCore.length) {
    // If forceOmgevingswet, ensure the Omgevingswet itself is present even if SRU missed it.
    if (forceOmgevingswet && !resCore.some(x => (x.id || "").toUpperCase() === OMGEVINGSWET_ID)) {
      resCore.unshift({
        id: OMGEVINGSWET_ID,
        title: "Omgevingswet",
        link: `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`,
        type: "BWB"
      });
    }
    return resCore;
  }

  // 2) Generic fallback: title any question (still filter Wabo later)
  const res2 = await run(`overheidbwb.titel any "${safeQ}"`);
  if (res2.length) return res2;

  // 3) Broad fallback: keyword splits
  const words = normalize(q).split(/\s+/).filter(w => w.length >= 6).slice(0, 6);
  if (words.length) {
    const cql3 = words.map(w => `overheidbwb.titel any "${w}"`).join(" OR ");
    const res3 = await run(cql3);
    if (res3.length) return res3;
  }

  // 4) Final: return at least Omgevingswet if forced
  if (forceOmgevingswet) {
    return removeBanned([{
      id: OMGEVINGSWET_ID,
      title: "Omgevingswet",
      link: `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`,
      type: "BWB"
    }]);
  }

  return [];
}

/* ================================
   Ranking
================================ */
function scoreSource({ s, qLc, scope }) {
  if (isBannedSource(s)) return -9999;
  const t = normalize(s?.title || "");
  let score = 0;

  // Strongly prefer primary Omgevingswet for legal-basis questions
  if ((s.id || "").toUpperCase() === OMGEVINGSWET_ID) score += 50;

  if (t === "omgevingswet" || t.includes("omgevingswet")) score += 20;
  if (t.includes("omgevingsbesluit")) score += 10;
  if (t.includes("besluit bouwwerken leefomgeving")) score += 12;
  if (t.includes("besluit kwaliteit leefomgeving")) score += 12;
  if (t.includes("besluit activiteiten leefomgeving")) score += 11;

  // Deprioritize amendment-y titles a bit
  if (t.includes("wijzig") || t.includes("aanvullings") || t.includes("verzamel")) score -= 4;

  // Match question keywords
  const kw = qLc.split(/\s+/).filter(w => w.length >= 5).slice(0, 12);
  for (const w of kw) if (t.includes(w)) score += 0.7;

  if (scope === "municipal") {
    if (s.type === "CVDR") score += 3;
    if ((s.type || "").toLowerCase().includes("gemeenteblad")) score += 1;
  } else {
    if (s.type === "BWB") score += 2.5;
  }

  return score;
}

function rankSources(sources, q, scope) {
  const qLc = normalize(q);
  const scored = (sources || []).map(s => ({ ...s, _score: scoreSource({ s, qLc, scope }) }));
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  return scored.filter(x => x._score > -9990);
}

/* ================================
   MAIN HANDLER
================================ */
export default async function handler(req, res) {
  // --- CORS / PREFLIGHT MUST BE FIRST ---
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

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt.", sources: [] });
  }

  const fetchWithTimeout = makeFetchWithTimeout();

  try {
    // -----------------------------
    // 0) Follow-up slot flow
    // -----------------------------
    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (Date.now() - pending.createdAt) < 7 * 60 * 1000;

    let collected = {};
    if (fresh) {
      collected = { ...(pending.collected || {}) };
      const missing = pending.missingSlots || [];

      if (missing.includes("municipality") && looksLikeMunicipality(q)) {
        collected.municipality = q.trim();
      }

      if (missing.includes("terrace_type") && !collected.terrace_type) {
        if (hasMeaningfulDetail(q)) collected.terrace_type = q.trim();
      }

      if (missing.includes("location_hint") && !collected.location_hint) {
        if (hasMeaningfulDetail(q)) collected.location_hint = q.trim();
      }

      if (missing.includes("topic_hint") && !collected.topic_hint) {
        if (hasMeaningfulDetail(q)) collected.topic_hint = q.trim();
      }

      const stillMissing = [];
      for (const slot of missing) {
        if (slot === "municipality" && !collected.municipality) stillMissing.push("municipality");
        if (slot === "terrace_type" && !collected.terrace_type) stillMissing.push("terrace_type");
        if (slot === "location_hint" && !collected.location_hint) stillMissing.push("location_hint");
        if (slot === "topic_hint" && !collected.topic_hint) stillMissing.push("topic_hint");
      }

      const attempts = Number.isFinite(pending.attempts) ? pending.attempts : 0;
      const MAX_ATTEMPTS = 3;

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

    const qLc = normalize(q);
    const municipality = collected.municipality || null;

    // -----------------------------
    // 1) Decide scope
    // -----------------------------
    const scope = decideScope(q);

    // Ask municipality only if scope is municipal and municipality missing
    if (scope === "municipal" && !municipality) {
      const need = ["municipality", ...(isTerraceQuestion(qLc) ? ["terrace_type"] : [])];

      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots: need,
          collected: { ...collected },
          createdAt: Date.now(),
          attempts: 0
        });
      }

      return res.status(200).json({ answer: askForMissing(need), sources: [] });
    }

    // If national scope but too vague, ask topic hint
    if (scope === "national" && isTooVagueGeneral(q) && !collected.topic_hint) {
      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots: ["topic_hint"],
          collected: { ...collected },
          createdAt: Date.now(),
          attempts: 0
        });
      }
      return res.status(200).json({ answer: questionForSlot("topic_hint"), sources: [] });
    }

    // -----------------------------
    // 2) Search sources
    // -----------------------------
    let sources = [];

    const isOmgevingsplanDeviationLegalBasis =
      (qLc.includes("afwijken") || qLc.includes("afwijking") || qLc.includes("tijdelijk")) &&
      qLc.includes("omgevingsplan") &&
      (qLc.includes("omgevingsvergunning") || qLc.includes("vergunning") || qLc.includes("welke bepaling") || qLc.includes("welk artikel"));

    if (scope === "municipal" && municipality) {
      if (isTerraceQuestion(qLc)) {
        const topic1 = "algemene plaatselijke verordening APV terras terrassen horeca";
        sources = await cvdrSearch({ municipalityName: municipality, topicWords: topic1, fetchWithTimeout });

        if (!sources.length) {
          const topic2 = "terras terrassen terrasvergunning horeca";
          sources = await cvdrSearch({ municipalityName: municipality, topicWords: topic2, fetchWithTimeout });
        }

        if (!sources.length) {
          const topic3 = "terras terrassen horeca";
          sources = await oepSearch({ municipalityName: municipality, topicWords: topic3, fetchWithTimeout });
        }
      } else {
        const topic = (collected.topic_hint && hasMeaningfulDetail(collected.topic_hint))
          ? `${collected.topic_hint} ${q}`
          : q;

        sources = await cvdrSearch({ municipalityName: municipality, topicWords: topic, fetchWithTimeout });
        if (!sources.length) sources = await oepSearch({ municipalityName: municipality, topicWords: topic, fetchWithTimeout });
      }
    } else {
      const q2 = (collected.topic_hint && hasMeaningfulDetail(collected.topic_hint))
        ? `${q} ${collected.topic_hint}`
        : q;

      // Force Omgevingswet for this category of question
      const forceOw = !!isOmgevingsplanDeviationLegalBasis || isLegalBasisQuestion(qLc) || qLc.includes("omgevingsplanactiviteit") || qLc.includes("bopa");

      sources = await bwbSearch({ q: q2, fetchWithTimeout, forceOmgevingswet: forceOw });
    }

    sources = removeBanned(dedupeByLink(sources));
    sources = rankSources(sources, q, scope).slice(0, 4).map(({ _score, ...s }) => s);

    if (!sources.length) {
      return res.status(200).json({
        answer:
          "Geen officiële bronnen gevonden. Probeer iets specifieker te formuleren (relevante kernbegrippen of, bij gemeentelijke vragen, de gemeente).",
        sources: []
      });
    }

    // -----------------------------
    // 3) Build sourcesText + (critical) include Omgevingswet art. 5.1 snippet if relevant
    // -----------------------------
    const needOwSnippet =
      scope === "national" &&
      (isOmgevingsplanDeviationLegalBasis || isLegalBasisQuestion(qLc) || qLc.includes("omgevingsplanactiviteit") || qLc.includes("bopa"));

    let owSnippet = null;
    if (needOwSnippet) {
      try {
        owSnippet = await wettenSnippetOmgevingswetArt51(fetchWithTimeout);
      } catch {
        owSnippet = null;
      }
    }

    const sourcesText = sources
      .map((s, i) => {
        const head = `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}`;
        const isOw = (s.id || "").toUpperCase() === OMGEVINGSWET_ID || normalize(s.title) === "omgevingswet";
        if (isOw && owSnippet) {
          return `${head}\n\nRelevante tekst (uittreksel):\n${owSnippet}`;
        }
        return head;
      })
      .join("\n\n---\n\n");

    // -----------------------------
    // 4) Answer ONLY from provided sources
    // -----------------------------
    const aiResp = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.1,
          max_tokens: 650,
          messages: [
            {
              role: "system",
              content: `
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen (incl. eventuele uittreksels).

STRICT:
- Noem GEEN wet/regeling als die naam/titel niet in de bronvermelding staat.
- Noem GEEN artikelnummer/bepaling als die niet letterlijk in de brontekst/uittreksel staat.
- NOOIT Wabo (Wet algemene bepalingen omgevingsrecht) noemen of gebruiken.
- Als de vraag vraagt naar een bepaling maar die staat niet letterlijk in de bronvermelding/uittreksel: zeg dat expliciet (geen aannames).

Geef:
1) Kort antwoord (max 3 zinnen)
2) Grondslag (exacte bepaling/ artikel/ lid/ onderdeel als die letterlijk in de bron staat)
3) Toelichting (bulletpoints) — alleen uit bron
Geen aparte bronnenlijst.
`
            },
            {
              role: "user",
              content:
                `Vraag:\n${q}\n` +
                (municipality ? `Gemeente (context): ${municipality}\n` : "") +
                `\nOfficiële bronnen:\n${sourcesText}`
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

    const ansLc = normalize(answer);
    if (ansLc.includes("wabo") || ansLc.includes("wet algemene bepalingen omgevingsrecht")) {
      answer = "Ik kan dit niet beantwoorden op basis van de aangeleverde bronnen (Wabo is niet toegestaan) en er staat geen expliciete actuele bepaling in de bronvermelding/uittreksel.";
    }

    // Never return banned sources
    sources = removeBanned(sources);

    return res.status(200).json({ answer, sources });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
