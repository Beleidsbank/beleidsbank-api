const rateStore = new Map();
const pendingStore = new Map(); // sessionId -> { question, createdAt }

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

function looksLikeMunicipality(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.length > 40) return false;
  return /^[\p{L}\s.'-]+$/u.test(t);
}

function normalize(s) {
  return (s || "").toLowerCase();
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter(s => {
    if (!s.link) return false;
    if (seen.has(s.link)) return false;
    seen.add(s.link);
    return true;
  });
}

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "https://app.beleidsbank.nl");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const { message, session_id } = req.body || {};
  let q = (message || "").trim();
  const sessionId = (session_id || "").trim();

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

  const pickAll = (text, re) => [...text.matchAll(re)].map(m => m[1]);

  try {

    // -------------------------
    // Pending gemeente flow
    // -------------------------

    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (Date.now() - pending.createdAt) < 5 * 60 * 1000;

    let municipality = null;

    if (fresh && looksLikeMunicipality(q)) {
      municipality = q.trim();
      q = pending.question;
      pendingStore.delete(sessionId);
    }

    // Als terras-vraag zonder gemeente
    if (!municipality && normalize(q).includes("terras")) {
      if (sessionId) {
        pendingStore.set(sessionId, {
          question: q,
          createdAt: Date.now()
        });
      }
      return res.status(200).json({
        answer: "Voor welke gemeente geldt dit?",
        sources: []
      });
    }

    // -------------------------
    // GEMEENTELIJKE SEARCH
    // -------------------------

    let sources = [];

    if (municipality) {

      const url =
        "https://zoek.officielebekendmakingen.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve&x-connection=oep&recordSchema=dc" +
        "&maximumRecords=50&startRecord=1" +
        "&query=" + encodeURIComponent(`publicatieNaam="Gemeenteblad"`);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

      const munLc = normalize(municipality);

      sources = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://zoek.officielebekendmakingen.nl/${id}.html`,
        type: "Gemeenteblad"
      }))
      .filter(s =>
        normalize(s.title).includes(munLc) &&
        (
          normalize(s.title).includes("terras") ||
          normalize(s.title).includes("horeca") ||
          normalize(s.title).includes("verordening")
        )
      );
    }

    sources = dedupe(sources).slice(0, 4);

    if (!sources.length) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden.",
        sources: []
      });
    }

    const sourcesText = sources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}`)
      .join("\n\n");

    // -------------------------
    // AI ANTWOORD
    // -------------------------

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
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: `
Gebruik uitsluitend de aangeleverde officiële bronnen.
Geef:
1) Kort antwoord
2) Toelichting
`
            },
            {
              role: "user",
              content: `Vraag:\n${q}\n\nBronnen:\n${sourcesText}`
            }
          ]
        })
      }
    );

    const aiData = await aiResp.json();
    const answer = aiData?.choices?.[0]?.message?.content || "Geen antwoord gegenereerd.";

    return res.status(200).json({
      answer,
      sources
    });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
