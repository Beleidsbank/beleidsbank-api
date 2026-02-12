// /api/chat.js — Beleidsbank V2-ready backend
//
// Goals:
// ✅ Backend returns ONLY 2 headings in `answer`:
//    Antwoord:
//    Toelichting:
// ✅ Frontend renders sources from `sources` array (no "Bronnen:" inside answer)
// ✅ Never show Wabo (hard ban)
// ✅ Never allow guessed article numbers (unless provided via excerpts; in this V2-ready version we don't inject excerpts yet)
// ✅ Strong stripping: if model prints "Bronnen/Sources" anyway, we remove it
// ✅ Debug-friendly errors (prevents "load failed" without details)
// ✅ CORS + OPTIONS included

const MAX_SOURCES_RETURN = 4;
const OMGEVINGSWET_ID = "BWBR0037885";

// WABO hard ban
const BANNED_IDS = new Set(["BWBR0024779", "BWBR0047270"]);

// ---------------------------
// Helpers
// ---------------------------
function normalize(s) {
  return (s || "").toLowerCase().trim();
}

function isBanned(item) {
  const id = (item?.id || "").toString().trim().toUpperCase();
  const title = normalize(item?.title || "");
  if (BANNED_IDS.has(id)) return true;
  if (title.includes("wabo")) return true;
  if (title.includes("wet algemene bepalingen omgevingsrecht")) return true;
  if (title.includes("algemene bepalingen omgevingsrecht")) return true;
  return false;
}

function removeBanned(items) {
  return (items || []).filter(x => !isBanned(x));
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

// Remove any model-generated sources section variants.
// We cut from the FIRST occurrence of "Bronnen" or "Sources" anywhere.
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

function makeFetchWithTimeout() {
  return async (url, options = {}, ms = 20000) => {
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
// Sources (V2-ready: still simple; routing comes later)
// ---------------------------
async function getNationalSources() {
  // V2-ready: you can expand this later to include Bbl/Bal/Bkl/Omgevingsbesluit based on routing.
  return [
    {
      id: OMGEVINGSWET_ID,
      title: "Omgevingswet",
      link: `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`,
      type: "BWB"
    }
  ];
}

// ---------------------------
// OpenAI
// ---------------------------
async function callOpenAI({ apiKey, fetchWithTimeout, question }) {
  const system = `
Je bent een juridisch assistent voor Nederlandse wetgeving.

Regels:
- Nooit Wabo noemen of gebruiken.
- Geef een praktisch en duidelijk antwoord (kort en bruikbaar).
- Noem GEEN artikelnummer of lidnummer (tenzij het letterlijk in aangeleverde tekst staat; in deze versie is dat niet zo).
- Print GEEN bronnen en géén kopje "Bronnen" of "Sources" (met of zonder dubbelepunt); bronnen worden apart door de applicatie getoond.

Output EXACT (ALLEEN deze twee koppen):
Antwoord:
Toelichting:
`.trim();

  const user = `Vraag:\n${question}`.trim();

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
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    },
    20000
  );

  const raw = await resp.text();

  if (!resp.ok) {
    return { ok: false, status: resp.status, raw };
  }

  try {
    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content || "";
    return { ok: true, content: content.trim() };
  } catch (e) {
    return { ok: false, status: 500, raw: `JSON parse failed: ${String(e)}\nRAW:\n${raw}` };
  }
}

// ---------------------------
// MAIN
// ---------------------------
export default async function handler(req, res) {
  // ---- CORS / OPTIONS ----
  // If you test locally, change allow to "http://localhost:3000" (or your dev origin)
  const origin = (req.headers.origin || "").toString();
  const allow = "https://app.beleidsbank.nl";

  res.setHeader("Access-Control-Allow-Origin", origin === allow ? origin : allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { message } = req.body || {};
  const q = (message || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing message" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt." });

  const fetchWithTimeout = makeFetchWithTimeout();

  try {
    // Sources (V2-ready)
    let sources = await getNationalSources();
    sources = removeBanned(dedupeByLink(sources)).slice(0, MAX_SOURCES_RETURN);

    // LLM
    const ai = await callOpenAI({ apiKey, fetchWithTimeout, question: q });

    if (!ai.ok) {
      return res.status(502).json({
        error: "OpenAI call failed",
        status: ai.status,
        details: (ai.raw || "").slice(0, 4000)
      });
    }

    // Clean + enforce format (2 headings only)
    let answer = stripSourcesFromAnswer(ai.content);
    answer = ensureTwoHeadings(answer);

    // Extra guardrail: if model still mentioned "bronnen/sources", strip again
    if (/\b(bronnen|sources)\b/i.test(answer)) {
      answer = stripSourcesFromAnswer(answer);
      answer = ensureTwoHeadings(answer);
    }

    // IMPORTANT (V2-ready): DO NOT append sources into answer.
    // Frontend will render sources from the array.
    return res.status(200).json({ answer, sources });
  } catch (e) {
    return res.status(500).json({
      error: "Interne fout",
      details: String(e?.stack || e)
    });
  }
}
