const rateStore = new Map();
const pendingStore = new Map(); 
// sessionId -> {
//   originalQuestion,
//   missingSlots: [],
//   collected: {},
//   createdAt
// }

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

/* ================================
   AI ANALYSE
================================ */

async function analyzeQuestionWithAI({ q, apiKey, fetchWithTimeout }) {
  const prompt = `
Analyseer een vraag over Nederlandse wet- en regelgeving.
Geef GEEN inhoudelijk antwoord.

Geef JSON met:
- scope: "municipal" | "national" | "unknown"
- municipality: string|null
- query_terms: array<string>
- include_terms: array<string>
- exclude_terms: array<string>
- missing_slots: array<string> (bv. ["municipality"] indien nodig)
- clarification_questions: array<string> (max 2)

Vraag:
"""${q}"""
`;

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 400,
        messages: [
          { role: "system", content: "Output ALLEEN geldige JSON." },
          { role: "user", content: prompt }
        ]
      })
    },
    15000
  );

  const raw = await resp.text();

  try {
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content;
    const data = JSON.parse(content);
    return {
      scope: data.scope || "unknown",
      municipality: data.municipality || null,
      query_terms: data.query_terms || [],
      include_terms: data.include_terms || [],
      exclude_terms: data.exclude_terms || [],
      missing_slots: data.missing_slots || [],
      clarification_questions: data.clarification_questions || []
    };
  } catch {
    return {
      scope: "unknown",
      municipality: null,
      query_terms: q.split(" "),
      include_terms: [],
      exclude_terms: [],
      missing_slots: [],
      clarification_questions: []
    };
  }
}

/* ================================
   SLOT EXTRACTION (NO LOOP FIX)
================================ */

async function extractSlotsWithAI({ userText, missingSlots, apiKey, fetchWithTimeout }) {
  const prompt = `
Extraheer alleen deze velden uit het antwoord.
Geef JSON.

Slots: ${JSON.stringify(missingSlots)}

Regels:
- municipality = alleen gemeentenaam
- detail = korte context (bv. "terras bij restaurant")

User antwoord:
"""${userText}"""
`;

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
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
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content;
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/* ================================
   SCORING
================================ */

function scoreSources({ sources, q, include, exclude, scope }) {
  const qLc = normalize(q);

  function scoreOne(s) {
    const title = normalize(s.title || "");
    let score = 0;

    include.forEach(t => {
      if (title.includes(normalize(t))) score += 2;
    });

    exclude.forEach(t => {
      if (!qLc.includes(normalize(t)) && title.includes(normalize(t))) {
        score -= 3;
      }
    });

    if (scope === "municipal" && s.type === "CVDR") score += 2;
    if (scope === "national" && s.type === "BWB") score += 2;

    return score;
  }

  const scored = sources.map(s => ({ ...s, _score: scoreOne(s) }));
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

function computeConfidence(scored) {
  if (!scored.length) return 0;
  const top = scored[0]._score;
  const second = scored[1]?._score || 0;
  return clamp((top - second + top) / 10, 0, 1);
}

/* ================================
   SEARCH FUNCTIONS
================================ */

async function cvdrSearch({ municipalityName, query, fetchWithTimeout }) {
  const base = "https://zoekdienst.overheid.nl/sru/Search";
  const cql = `(dcterms.creator="${municipalityName}") AND (keyword all "${query}")`;

  const url =
    `${base}?version=1.2&operation=searchRetrieve&x-connection=cvdr` +
    `&maximumRecords=25&startRecord=1&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url, {}, 15000);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(CVDR[0-9_]+)<\/dcterms:identifier>/g);
  const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

  return dedupeByLink(
    ids.map((id, i) => ({
      title: titles[i] || id,
      link: `https://lokaleregelgeving.overheid.nl/${id}`,
      type: "CVDR"
    }))
  );
}

async function bwbSearch({ query, fetchWithTimeout }) {
  const base = "https://zoekservice.overheid.nl/sru/Search";
  const url =
    `${base}?version=1.2&operation=searchRetrieve&x-connection=BWB` +
    `&maximumRecords=15&startRecord=1&query=` +
    encodeURIComponent(`overheidbwb.titel any "${query}"`);

  const resp = await fetchWithTimeout(url, {}, 15000);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
  const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

  return dedupeByLink(
    ids.map((id, i) => ({
      title: titles[i] || id,
      link: `https://wetten.overheid.nl/${id}`,
      type: "BWB"
    }))
  );
}

/* ================================
   MAIN HANDLER
================================ */

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
  const sessionId = (session_id || "").trim();
  let q = (message || "").trim();
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

    /* ========= SLOT FILLING ========= */

    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (Date.now() - pending.createdAt) < 600000;

    if (fresh) {

      const extracted = await extractSlotsWithAI({
        userText: q,
        missingSlots: pending.missingSlots,
        apiKey,
        fetchWithTimeout
      });

      Object.assign(pending.collected, extracted);

      const stillMissing = pending.missingSlots.filter(
        s => !pending.collected[s]
      );

      if (!stillMissing.length) {
        q = pending.originalQuestion;
        pendingStore.delete(sessionId);
      } else {
        pending.missingSlots = stillMissing;
        pendingStore.set(sessionId, pending);
        return res.status(200).json({
          answer: "Kun je dit nog iets concreter maken?",
          sources: []
        });
      }
    }

    /* ========= ANALYSE ========= */

    const analysis = await analyzeQuestionWithAI({
      q,
      apiKey,
      fetchWithTimeout
    });

    let municipality = analysis.municipality;

    if (analysis.scope === "municipal" && !municipality) {
      if (sessionId) {
        pendingStore.set(sessionId, {
          originalQuestion: q,
          missingSlots: ["municipality"],
          collected: {},
          createdAt: Date.now()
        });
      }

      return res.status(200).json({
        answer: "Voor welke gemeente geldt dit?",
        sources: []
      });
    }

    /* ========= SEARCH ========= */

    let sources = [];

    if (analysis.scope === "municipal") {
      sources = await cvdrSearch({
        municipalityName: municipality,
        query: analysis.query_terms.join(" "),
        fetchWithTimeout
      });
    } else {
      sources = await bwbSearch({
        query: analysis.query_terms.join(" "),
        fetchWithTimeout
      });
    }

    const scored = scoreSources({
      sources,
      q,
      include: analysis.include_terms,
      exclude: analysis.exclude_terms,
      scope: analysis.scope
    });

    const confidence = computeConfidence(scored);
    const topSources = scored.slice(0, 4);

    if (confidence < 0.3) {
      return res.status(200).json({
        answer: analysis.clarification_questions?.[0] ||
          "Kun je je vraag iets specifieker formuleren?",
        sources: []
      });
    }

    if (!topSources.length) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden.",
        sources: []
      });
    }

    /* ========= FINAL ANSWER ========= */

    const sourcesText = topSources
      .map((s, i) =>
        `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}`
      )
      .join("\n\n");

    const aiResp = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.2,
          max_tokens: 500,
          messages: [
            {
              role: "system",
              content:
                "Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen."
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

    const raw = await aiResp.text();
    const parsed = JSON.parse(raw);
    let answer = parsed?.choices?.[0]?.message?.content || "";
    answer = stripSourcesFromAnswer(answer);

    return res.status(200).json({
      answer,
      sources: topSources
    });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
