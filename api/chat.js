// /api/chat.js — Beleidsbank V1 (Simple & Reliable)

const rateStore = new Map();
const cacheStore = new Map();

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const MAX_SOURCES_RETURN = 8;
const MAX_EXCERPTS_FETCH = 6;

// ------------------ helpers ------------------

function nowMs() { return Date.now(); }

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

function pickAll(text, re) {
  return [...text.matchAll(re)].map(m => m[1]);
}

function cacheGet(key) {
  const it = cacheStore.get(key);
  if (!it) return null;
  if (nowMs() > it.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
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

// ------------------ parsing ------------------

function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickRelevantLines(text, keywords = [], max = 20) {
  const lines = text.split("\n").map(x => x.trim()).filter(Boolean);
  if (!keywords.length) return lines.slice(0, max).join("\n");

  const hits = lines.filter(l =>
    keywords.some(k => normalize(l).includes(normalize(k)))
  );

  return (hits.length ? hits : lines).slice(0, max).join("\n");
}

// ------------------ OpenAI ------------------

async function callOpenAI({ apiKey, fetchWithTimeout, messages, max_tokens = 800 }) {
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
        max_tokens,
        messages
      })
    },
    20000
  );

  const raw = await resp.text();
  if (!resp.ok) return { ok: false, raw };

  try {
    const data = JSON.parse(raw);
    return { ok: true, content: data?.choices?.[0]?.message?.content || "" };
  } catch {
    return { ok: false, raw };
  }
}

// ------------------ SRU SEARCH ------------------

async function bwbSearch({ query, fetchWithTimeout }) {
  const cql = `overheidbwb.titel any "${query.replaceAll('"', "")}"`;

  const url =
    `https://zoekservice.overheid.nl/sru/Search` +
    `?version=1.2&operation=searchRetrieve&x-connection=BWB` +
    `&maximumRecords=25&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
  const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

  return dedupeByLink(ids.map((id, i) => ({
    id,
    title: titles[i] || id,
    link: `https://wetten.overheid.nl/${id}`,
    type: "BWB"
  })));
}

async function cvdrSearch({ query, fetchWithTimeout }) {
  const cql = `keyword all "${query.replaceAll('"', "")}"`;

  const url =
    `https://zoekdienst.overheid.nl/sru/Search` +
    `?version=1.2&operation=searchRetrieve&x-connection=cvdr` +
    `&maximumRecords=25&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url);
  const xml = await resp.text();

  const ids = pickAll(xml, /<dcterms:identifier>(CVDR[0-9_]+)<\/dcterms:identifier>/g);
  const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

  return dedupeByLink(ids.map((id, i) => ({
    id,
    title: titles[i] || id,
    link: `https://lokaleregelgeving.overheid.nl/${id}`,
    type: "CVDR"
  })));
}

// ------------------ MAIN ------------------

export default async function handler(req, res) {

  // CORS
  const origin = (req.headers.origin || "").toString();
  res.setHeader("Access-Control-Allow-Origin",
    origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip))
    return res.status(429).json({ error: "Too many requests" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  const body = req.body || {};
  const question =
    body.message ||
    body.messages?.at(-1)?.content;

  if (!question)
    return res.status(400).json({ error: "Missing message" });

  const fetchWithTimeout = makeFetchWithTimeout();

  // ---------- search ----------
  let sources = [];

  sources.push(...await bwbSearch({
    query: question,
    fetchWithTimeout
  }));

  sources.push(...await cvdrSearch({
    query: question,
    fetchWithTimeout
  }));

  sources = dedupeByLink(sources);

  // ---------- excerpts ----------
  const excerpts = [];
  for (const s of sources.slice(0, MAX_EXCERPTS_FETCH)) {
    const cacheKey = `ex:${s.id}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      excerpts.push(cached);
      continue;
    }

    try {
      const html = await (await fetchWithTimeout(s.link)).text();
      const text = htmlToTextLite(html);

      const ex = {
        source: s,
        excerpt: pickRelevantLines(text, question.split(" "), 20).slice(0, 2500)
      };

      cacheSet(cacheKey, ex, 2 * 60 * 60 * 1000);
      excerpts.push(ex);
    } catch {}
  }

  // ---------- answer ----------
  const system = `
Je bent Beleidsbank.

Doel:
- Geef een globaal, praktisch antwoord.
- Niet te juridisch diep.
- Gebruiker kan zelf in bronnen verder lezen.

Regels:
- Noem GEEN bronnen in de tekst.
- Noem alleen artikelnummers als ze letterlijk in excerpts staan.
- Als info onzeker is: zeg dat.
- Als gemeente relevant is maar ontbreekt: geef algemeen antwoord en zeg dat lokale regels kunnen verschillen.
`;

  const user = JSON.stringify({
    question,
    excerpts
  });

  const ai = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  const answer =
    ai.ok
      ? ai.content
      : "Ik kon nu geen volledig antwoord genereren. Probeer het opnieuw.";

  return res.status(200).json({
    answer,
    sources: sources.slice(0, MAX_SOURCES_RETURN)
  });
}
