const rateStore = new Map();
const pendingStore = new Map(); // sessionId -> { originalQuestion, missingSlots, collected, createdAt, lastAsk }

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

function normalize(s) { return (s || "").toLowerCase().trim(); }

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

function pickAll(text, re) { return [...text.matchAll(re)].map(m => m[1]); }

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

/** ============================
 *  1) AI analyse / clarify
 *  ============================ */
async function analyzeQuestionWithAI({ q, municipalityHint, apiKey, fetchWithTimeout }) {
  const prompt = `
Je taak: analyseer een gebruikersvraag over NL beleid/wet/regelgeving.
Geef GEEN inhoudelijk antwoord.
Geef JSON met:
- scope: "municipal" | "national" | "unknown"
- municipality: string|null (alleen als scope municipal en expliciet genoemd)
- query_terms: array<string> (belangrijkste zoektermen, 3-10)
- include_terms: array<string> (extra termen die vaak nodig zijn voor vindbaarheid)
- exclude_terms: array<string> (ruistermen die NIET relevant zijn voor deze vraag)
- is_too_vague: boolean (true als vraag te kort/ambigu is om goede bronnen te kiezen)
- clarification_questions: array<string> (max 2, meest informatief, kort en concreet)
Regels:
- Als scope municipal en municipality ontbreekt: voeg een vraag toe: "Voor welke gemeente geldt dit?"
- Stel anders alleen vervolgvragen als is_too_vague true.
- exclude_terms: alleen dingen die typisch ruis zijn t.o.v. deze vraag (bv. andere onderwerpen), maar NIET uitsluiten als gebruiker het expliciet noemt.
Vraag: """${q}"""
Municipality hint (heuristic): ${municipalityHint ? "true" : "false"}
`;

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 350,
        messages: [
          { role: "system", content: "Je output is ALLEEN geldige JSON. Geen uitleg, geen markdown." },
          { role: "user", content: prompt }
        ]
      })
    },
    15000
  );

  const raw = await resp.text();
  let data = null;
  try {
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content?.trim();
    data = JSON.parse(content);
  } catch {
    // fallback minimal
    data = {
      scope: municipalityHint ? "municipal" : "unknown",
      municipality: null,
      query_terms: q.split(/\s+/).slice(0, 6),
      include_terms: [],
      exclude_terms: [],
      is_too_vague: q.trim().length < 20,
      clarification_questions: municipalityHint ? ["Voor welke gemeente geldt dit?"] : []
    };
  }

  // normaliseer arrays
  const arr = (x) => Array.isArray(x) ? x.filter(Boolean).map(String) : [];
  return {
    scope: ["municipal","national","unknown"].includes(data.scope) ? data.scope : "unknown",
    municipality: data.municipality ? String(data.municipality) : null,
    query_terms: arr(data.query_terms).slice(0, 12),
    include_terms: arr(data.include_terms).slice(0, 12),
    exclude_terms: arr(data.exclude_terms).slice(0, 20),
    is_too_vague: !!data.is_too_vague,
    clarification_questions: arr(data.clarification_questions).slice(0, 2),
  };
}

/** ============================
 *  2) SRU zoeken
 *  ============================ */
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
  // publicatieNaam="Gemeenteblad" en query in keyword (werkt grof maar helpt)
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
    title: titles[i] || id,
    link: `https://zoek.officielebekendmakingen.nl/${id}.html`,
    type: "OEP (Gemeenteblad)"
  }));

  return dedupeByLink(items);
}

async function bwbSearch({ q, cqlTopic, fetchWithTimeout }) {
  const base = "https://zoekservice.overheid.nl/sru/Search";
  // BWB: combineer originele vraag met AI-termen
  const query = cqlTopic
    ? `(overheidbwb.titel any "${q}") OR (overheidbwb.titel any "${cqlTopic}")`
    : `overheidbwb.titel any "${q}"`;

  const url =
    `${base}?version=1.2&operation=searchRetrieve&x-connection=BWB` +
    `&maximumRecords=12&startRecord=1` +
    `&query=${encodeURIComponent(query)}`;

  const resp = await fetchWithTimeout(url, {}, 15000);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
  const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

  return dedupeByLink(ids.map((id, i) => ({
    title: titles[i] || id,
    link: `https://wetten.overheid.nl/${id}`,
    type: "BWB"
  })));
}

/** ============================
 *  3) CQL builder + scoring
 *  ============================ */
function buildCqlFromTerms(terms = []) {
  const clean = terms.map(t => String(t).trim()).filter(t => t.length >= 2);
  if (!clean.length) return `keyword all ""`;
  // SRU keyword all "a b c" is grof; OR-tjes helpen soms beter voor recall
  // We bouwen: (keyword all "t1") OR (keyword all "t2") ...
  const parts = clean.slice(0, 8).map(t => `keyword all "${t.replaceAll('"', "")}"`);
  return parts.join(" OR ");
}

function scoreSources({ sources, q, queryTerms, includeTerms, excludeTerms, scope }) {
  const qLc = normalize(q);
  const pos = [...new Set([...queryTerms, ...includeTerms].map(normalize).filter(Boolean))];
  const neg = [...new Set(excludeTerms.map(normalize).filter(Boolean))];

  // penalty alleen als de term NIET in de vraag voorkomt
  const activeNeg = neg.filter(t => t && !qLc.includes(t));

  const typeBoost = (type) => {
    // lichte bias afhankelijk van scope
    if (scope === "municipal") {
      if (type === "CVDR") return 3.0;
      if ((type || "").toLowerCase().includes("gemeenteblad")) return 1.5;
    }
    if (scope === "national") {
      if (type === "BWB") return 2.5;
    }
    return 0.5;
  };

  const scoreOne = (s) => {
    const title = normalize(s?.title || "");
    let score = 0;

    // matches op zoektermen in titel
    for (const t of pos) {
      if (!t) continue;
      if (title.includes(t)) score += 2.2;
    }

    // matches op originele vraagwoorden (grof)
    const qWords = qLc.split(/\s+/).filter(w => w.length >= 4).slice(0, 10);
    for (const w of qWords) if (title.includes(w)) score += 0.6;

    // penalties
    for (const t of activeNeg) {
      if (title.includes(t)) score -= 3.0;
    }

    // lichte algemene ruis-penalty (jaarverslag etc.)
    const genericNoise = ["jaarverslag", "jaarrekening", "aanbested", "subsidieplafond", "inspraakreactie"];
    for (const n of genericNoise) if (title.includes(n) && !qLc.includes(n)) score -= 1.2;

    score += typeBoost(s.type);
    return score;
  };

  const scored = (sources || []).map(s => ({ ...s, _score: scoreOne(s) }));
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  return scored;
}

function computeConfidence(scoredSources) {
  if (!scoredSources?.length) return 0;
  const top = scoredSources[0]?._score ?? 0;
  const second = scoredSources[1]?._score ?? 0;
  // confidence: top moet redelijk hoog zijn én duidelijk beter dan #2
  const gap = top - second;
  const conf = clamp((top / 8) + (gap / 4), 0, 1); // heuristiek
  return conf;
}

/** ============================
 *  4) handler
 *  ============================ */
export default async function handler(req, res) {
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
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt." });

    // 0) Multi-turn clarify state
    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (Date.now() - pending.createdAt) < 7 * 60 * 1000;

    if (fresh) {
      // simpele invulling: als we één slot missen en user antwoordt kort, vullen we dat
      // (je kunt dit later uitbreiden naar meerdere slots)
      const missing = pending.missingSlots || [];
      const collected = pending.collected || {};
      const userShort = q.length <= 60;

      if (missing.includes("municipality") && userShort && looksLikeMunicipality(q)) {
        collected.municipality = q.trim();
        pending.missingSlots = missing.filter(x => x !== "municipality");
        pending.collected = collected;

        // zet q terug naar oorspronkelijke vraag
        q = pending.originalQuestion;
      } else if (missing.length && userShort) {
        // generieke: neem antwoord als "detail"
        collected.detail = q.trim();
        pending.missingSlots = [];
        pending.collected = collected;
        q = pending.originalQuestion;
      }

      if (!pending.missingSlots.length) pendingStore.delete(sessionId);
      else pendingStore.set(sessionId, pending);
    }

    // 1) Heuristiek: “lijkt gemeentelijk?”
    const qLc = normalize(q);
    const municipalityHint =
      qLc.includes("apv") ||
      qLc.includes("vergunning") ||
      qLc.includes("horeca") ||
      qLc.includes("terras") ||
      qLc.includes("standplaats") ||
      qLc.includes("evenement") ||
      qLc.includes("parkeer") ||
      qLc.includes("omgevingsvergunning") ||
      qLc.includes("bouwen") ||
      qLc.includes("bestemmingsplan");

    // 2) AI analyse (scope + zoektermen + eventuele vervolgvragen)
    const analysis = await analyzeQuestionWithAI({
      q,
      municipalityHint,
      apiKey,
      fetchWithTimeout
    });

    // merge eventueel collected municipality
    let municipality = analysis.municipality;
    if (!municipality && fresh && pending?.collected?.municipality) {
      municipality = pending.collected.municipality;
    }

    // 3) Als AI zegt: te vaag / gemeente nodig → stel vraag i.p.v. zoeken
    //    (max 2 vervolgvragen, en we bewaren state)
    const clarifyQs = (analysis.clarification_questions || []).filter(Boolean);
    const needsMunicipality = analysis.scope === "municipal" && !municipality;

    // confidence gate: als vraag superkort en scope onbekend, ook vragen
    const veryShort = q.trim().split(/\s+/).filter(Boolean).length <= 3;

    if (needsMunicipality || analysis.is_too_vague || (analysis.scope === "unknown" && veryShort)) {
      const toAsk = [];
      if (needsMunicipality) toAsk.push("Voor welke gemeente geldt dit?");
      for (const s of clarifyQs) {
        if (toAsk.length >= 2) break;
        if (!toAsk.includes(s)) toAsk.push(s);
      }
      if (!toAsk.length) toAsk.push("Kun je je vraag iets specifieker maken (waarover precies, en in welke context)?");

      // state bewaren zodat we volgende input kunnen koppelen
      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots: needsMunicipality ? ["municipality"] : ["detail"],
          collected: {},
          createdAt: Date.now(),
          lastAsk: toAsk
        });
      }

      return res.status(200).json({
        answer: toAsk.length === 1 ? toAsk[0] : `Ik heb nog ${toAsk.length} korte vragen:\n- ${toAsk.join("\n- ")}`,
        sources: []
      });
    }

    // 4) Build CQL topic (generiek) uit AI-termen
    const cqlTopic = buildCqlFromTerms([...analysis.query_terms, ...analysis.include_terms]);

    // 5) Zoeken
    let sources = [];
    if (analysis.scope === "municipal" && municipality) {
      // eerst CVDR (lokale regels), dan OEP (Gemeenteblad)
      sources = await cvdrSearch({ municipalityName: municipality, cqlTopic, fetchWithTimeout });
      if (!sources.length) sources = await oepSearch({ municipalityName: municipality, cqlTopic, fetchWithTimeout });
    } else {
      // landelijk/unknown -> BWB als primaire
      sources = await bwbSearch({ q, cqlTopic: analysis.query_terms.join(" "), fetchWithTimeout });
    }

    sources = dedupeByLink(sources);

    // 6) Rerank/scoring (dynamic; blacklist alleen als niet in vraag)
    const scored = scoreSources({
      sources,
      q,
      queryTerms: analysis.query_terms,
      includeTerms: analysis.include_terms,
      excludeTerms: analysis.exclude_terms,
      scope: analysis.scope
    });

    const confidence = computeConfidence(scored);
    const topSources = scored.slice(0, 4);

    // 7) Als bronnen ruisig / lage confidence -> stel 1 vraag extra (niet 10 topics)
    if (confidence < 0.35) {
      const followUp = (analysis.clarification_questions || [])[0] || "Kun je aangeven wat je precies bedoelt (context/activiteit/locatie)?";
      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots: ["detail"],
          collected: { municipality },
          createdAt: Date.now(),
          lastAsk: [followUp]
        });
      }
      return res.status(200).json({
        answer: followUp,
        sources: topSources // optioneel: je kunt dit ook leeg laten
      });
    }

    if (!topSources.length) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden. Probeer iets concreter te formuleren (kernbegrippen/onderwerp).",
        sources: []
      });
    }

    // 8) Antwoord genereren: ALLEEN op bronnen
    const sourcesText = topSources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}`)
      .join("\n\n");

    const aiResp = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.2,
          max_tokens: 520,
          messages: [
            {
              role: "system",
              content: `
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen.
Geef:
1) Kort antwoord (max 4 zinnen)
2) Toelichting (alleen uit bronnen)
Geef GEEN aparte bronnenlijst.
Als bronnen het niet beantwoorden: zeg dat expliciet.
`
            },
            { role: "user", content: `Vraag:\n${q}\n\nOfficiële bronnen:\n${sourcesText}` }
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

    return res.status(200).json({ answer, sources: topSources });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
