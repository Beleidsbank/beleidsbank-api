// /api/chat.js — Beleidsbank V1 (stable, practical version)

const MAX_SOURCES_RETURN = 4;
const OMGEVINGSWET_ID = "BWBR0037885";

const BANNED_IDS = new Set([
  "BWBR0024779",
  "BWBR0047270"
]);

// ---------------------------
// Helpers
// ---------------------------

function normalize(s) {
  return (s || "").toLowerCase().trim();
}

function dedupeByLink(arr) {
  const seen = new Set();
  return (arr || []).filter(s => {
    if (!s?.link) return false;
    if (seen.has(s.link)) return false;
    seen.add(s.link);
    return true;
  });
}

function isBanned(item) {
  const id = (item?.id || "").toUpperCase();
  const title = normalize(item?.title);
  if (BANNED_IDS.has(id)) return true;
  if (title.includes("wabo")) return true;
  if (title.includes("wet algemene bepalingen omgevingsrecht")) return true;
  return false;
}

function removeBanned(items) {
  return (items || []).filter(x => !isBanned(x));
}

function stripSourcesFromAnswer(answer) {
  const re = /bronnen\s*:/i;
  const m = re.exec(answer);
  if (!m) return answer.trim();
  return answer.slice(0, m.index).trim();
}

function formatSourcesBlock(sources) {
  const lines = sources.map(s =>
    `- ${s.title} (${s.type} · ${s.id}) — ${s.link}`
  );

  return ["Bronnen:", lines.join("\n")].join("\n");
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
// Basic National Source (V1 simplified)
// ---------------------------

async function getNationalSources() {
  return [{
    id: OMGEVINGSWET_ID,
    title: "Omgevingswet",
    link: `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`,
    type: "BWB"
  }];
}

// ---------------------------
// OpenAI
// ---------------------------

async function callOpenAI({ apiKey, fetchWithTimeout, question }) {

  const system = `
Je bent een juridisch assistent voor Nederlandse wetgeving.

Regels:
- Nooit Wabo noemen.
- Geef een praktisch en duidelijk antwoord.
- Noem indien mogelijk de relevante wet.
- Output EXACT dit format:

Antwoord:
Toelichting:
`;

  const user = `
Vraag:
${question}
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
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: "system", content: system.trim() },
          { role: "user", content: user.trim() }
        ]
      })
    }
  );

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

// ---------------------------
// MAIN
// ---------------------------

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: "Missing message" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing API key" });
  }

  const fetchWithTimeout = makeFetchWithTimeout();

  try {

    // --- V1: Only national source (expand in V2) ---
    let sources = await getNationalSources();
    sources = removeBanned(dedupeByLink(sources)).slice(0, MAX_SOURCES_RETURN);

    let answer = await callOpenAI({
      apiKey,
      fetchWithTimeout,
      question: message
    });

    answer = stripSourcesFromAnswer(answer);

    if (!answer.toLowerCase().includes("antwoord:")) {
      answer = `Antwoord:\nEr kon geen duidelijk antwoord worden gegenereerd.\n\nToelichting:\n- Controleer de vraagformulering.`;
    }

    const sourcesBlock = formatSourcesBlock(sources);

    const final = `${answer}\n\n${sourcesBlock}`;

    return res.status(200).json({
      answer: final,
      sources
    });

  } catch (err) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
