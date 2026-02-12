// /api/chat.js — Beleidsbank V1 (robust + debug-friendly)

const MAX_SOURCES_RETURN = 4;
const OMGEVINGSWET_ID = "BWBR0037885";

// WABO hard ban
const BANNED_IDS = new Set(["BWBR0024779", "BWBR0047270"]);

function normalize(s) {
  return (s || "").toLowerCase().trim();
}

function isBanned(item) {
  const id = (item?.id || "").toString().trim().toUpperCase();
  const title = normalize(item?.title || "");
  if (BANNED_IDS.has(id)) return true;
  if (title.includes("wabo")) return true;
  if (title.includes("wet algemene bepalingen omgevingsrecht")) return true;
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

function stripSourcesFromAnswer(answer) {
  const a = (answer || "").trim();
  if (!a) return a;
  const m = /bronnen\s*:/i.exec(a); // FIXED regex
  if (!m) return a;
  return a.slice(0, m.index).trim();
}

function formatSourcesBlock(sources) {
  const lines = (sources || []).map(s => {
    const title = (s?.title || "").toString().trim();
    const type = (s?.type || "").toString().trim();
    const id = (s?.id || "").toString().trim();
    const link = (s?.link || "").toString().trim();
    return `- ${title}${type || id ? ` (${[type, id].filter(Boolean).join(" · ")})` : ""}${link ? ` — ${link}` : ""}`;
  });

  return ["Bronnen:", lines.length ? lines.join("\n") : "- (geen bronnen)"].join("\n");
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

async function getNationalSources() {
  return [
    {
      id: OMGEVINGSWET_ID,
      title: "Omgevingswet",
      link: `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`,
      type: "BWB"
    }
  ];
}

async function callOpenAI({ apiKey, fetchWithTimeout, question }) {
  const system = `
Je bent een juridisch assistent voor Nederlandse wetgeving.

Regels:
- Nooit Wabo noemen.
- Geef een praktisch en duidelijk antwoord (geen lange disclaimers).
- Output exact dit format (ALLEEN deze twee koppen):

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
    // Return detailed error upstream
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

export default async function handler(req, res) {
  // ---- CORS / OPTIONS ----
  const origin = (req.headers.origin || "").toString();
  const allow = "https://app.beleidsbank.nl"; // pas aan indien nodig
  res.setHeader("Access-Control-Allow-Origin", origin === allow ? origin : allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // ---- body ----
  const { message } = req.body || {};
  const q = (message || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing message" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt." });

  const fetchWithTimeout = makeFetchWithTimeout();

  try {
    // Sources (V1)
    let sources = await getNationalSources();
    sources = removeBanned(dedupeByLink(sources)).slice(0, MAX_SOURCES_RETURN);

    // OpenAI
    const ai = await callOpenAI({ apiKey, fetchWithTimeout, question: q });

    if (!ai.ok) {
      // << DIT maakt je fout zichtbaar i.p.v. “load failed”
      return res.status(502).json({
        error: "OpenAI call failed",
        status: ai.status,
        details: ai.raw?.slice(0, 4000) // keep it bounded
      });
    }

    let answer = stripSourcesFromAnswer(ai.content);

    // Ensure 2 headings exist
    const lc = answer.toLowerCase();
    if (!lc.includes("antwoord:") || !lc.includes("toelichting:")) {
      answer = [
        "Antwoord:",
        "Er kon geen goed geformatteerd antwoord worden gegenereerd.",
        "",
        "Toelichting:",
        "- Probeer de vraag iets concreter te maken."
      ].join("\n");
    }

    // Append bronnen as 3rd heading
    const final = `${answer}\n\n${formatSourcesBlock(sources)}`;

    return res.status(200).json({ answer: final, sources });
  } catch (e) {
    // << ook hier: error zichtbaar maken
    return res.status(500).json({
      error: "Interne fout",
      details: String(e?.stack || e)
    });
  }
}
