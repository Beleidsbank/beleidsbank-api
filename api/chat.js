// /api/chat.js — Beleidsbank (stable production version)

const rateStore = new Map();
const pendingStore = new Map();
const cacheStore = new Map();

const MAX_SOURCES_RETURN = 4;
const OMGEVINGSWET_ID = "BWBR0037885";
const NO_QUOTE_PLACEHOLDER = "(geen normquote gevonden in aangeleverde tekst)";

// ---------------------------
// Utils
// ---------------------------

function nowMs() { return Date.now(); }

function normalize(s) {
  return (s || "").toLowerCase().trim();
}

function rateLimit(ip, limit = 15, windowMs = 60000) {
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

function dedupeByLink(arr) {
  const seen = new Set();
  return (arr || []).filter(s => {
    if (!s?.link) return false;
    if (seen.has(s.link)) return false;
    seen.add(s.link);
    return true;
  });
}

// ---------------------------
// WABO HARD BAN
// ---------------------------

const BANNED_BWBR_IDS = new Set([
  "BWBR0024779",
  "BWBR0047270"
]);

function isBannedSource(item) {
  const id = (item?.id || "").toUpperCase();
  const title = normalize(item?.title);

  if (BANNED_BWBR_IDS.has(id)) return true;
  if (title.includes("wabo")) return true;
  if (title.includes("wet algemene bepalingen omgevingsrecht")) return true;

  return false;
}

function removeBanned(items) {
  return (items || []).filter(x => !isBannedSource(x));
}

// ---------------------------
// Strict Mode Detection
// ---------------------------

function isStrictNormQuestion(q) {
  const qLc = normalize(q);
  return (
    qLc.includes("noem de normzin") ||
    qLc.includes("welke normzin") ||
    qLc.includes("op grond van welk artikel") ||
    qLc.includes("welke bepaling")
  );
}

// ---------------------------
// Fetch Helper
// ---------------------------

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
// BWB Search (simplified stable version)
// ---------------------------

async function bwbSearch(fetchWithTimeout) {
  return [{
    id: OMGEVINGSWET_ID,
    title: "Omgevingswet",
    link: `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`,
    type: "BWB"
  }];
}

// ---------------------------
// Norm Extraction (only for strict mode)
// ---------------------------

function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h\d|br)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNormSentence(text) {
  const match = text.match(/het is verboden .*? omgevingsvergunning.*?\./i);
  return match ? `"${match[0].trim()}"` : null;
}

async function fetchOmgevingswetNorm(fetchWithTimeout) {
  const url = `https://wetten.overheid.nl/${OMGEVINGSWET_ID}`;
  const resp = await fetchWithTimeout(url);
  const html = await resp.text();
  const text = htmlToTextLite(html);
  return extractNormSentence(text);
}

// ---------------------------
// Output Formatting
// ---------------------------

function stripSourcesFromAnswer(answer) {
  const a = (answer || "").trim();
  const re = /bronnen\s*:/i;
  const m = re.exec(a);
  if (!m) return a;
  return a.slice(0, m.index).trim();
}

function formatSourcesBlock(sources) {
  const lines = sources.map(s =>
    `- ${s.title} (${s.type} · ${s.id}) — ${s.link}`
  );

  return ["Bronnen:", lines.join("\n")].join("\n");
}

// ---------------------------
// OpenAI Call
// ---------------------------

async function callOpenAI({ apiKey, fetchWithTimeout, q, strictMode, strictQuote }) {

  const system = `
Je beantwoordt vragen over Nederlands beleid en wetgeving.

STRICT:
- Nooit Wabo noemen.
- Noem alleen wetten die in de bronlijst staan.

Output EXACT:
Antwoord:
Toelichting:
`;

  const user = `
Vraag:
${q}

${strictMode && strictQuote
  ? `Gebruik deze normzin exact:\n${strictQuote}`
  : strictMode
  ? `Geen normzin gevonden.`
  : ""}
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
        max_tokens: 500,
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
// MAIN HANDLER
// ---------------------------

export default async function handler(req, res) {

  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip))
    return res.status(429).json({ error: "Too many requests" });

  const { message } = req.body || {};
  if (!message)
    return res.status(400).json({ error: "Missing message" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Missing API key" });

  const fetchWithTimeout = makeFetchWithTimeout();
  const strictMode = isStrictNormQuestion(message);

  let sources = await bwbSearch(fetchWithTimeout);
  sources = removeBanned(dedupeByLink(sources));

  let strictQuote = null;

  if (strictMode) {
    try {
      strictQuote = await fetchOmgevingswetNorm(fetchWithTimeout);
    } catch {}
  }

  let answer = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    q: message,
    strictMode,
    strictQuote
  });

  answer = stripSourcesFromAnswer(answer);

  if (!answer.toLowerCase().includes("antwoord:"))
    answer = `Antwoord:\nIk kan dit niet bevestigen.\n\nToelichting:\n- ${NO_QUOTE_PLACEHOLDER}`;

  const sourcesBlock = formatSourcesBlock(sources);

  const final = `${answer}\n\n${sourcesBlock}`;

  return res.status(200).json({
    answer: final,
    sources
  });
}
