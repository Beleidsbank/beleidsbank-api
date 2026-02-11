const rateStore = new Map();
const pendingStore = new Map(); // sessionId -> { question, type, createdAt }

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

function extractKeywords(q) {
  const cleaned = normalize(q).replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = cleaned.split(/\s+/).filter(w => w.length >= 4);
  return words.slice(0, 5).join(" ") || cleaned;
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
    let routeType = "national";

    if (fresh && looksLikeMunicipality(q)) {
      municipality = q.trim();
      routeType = pending.type;
      q = pending.question;
      pendingStore.delete(sessionId);
    } else {
      // simpele detectie: als "gemeente" of plaatsnaam in vraag voorkomt
      if (normalize(q).includes("amsterdam") ||
          normalize(q).includes("utrecht") ||
          normalize(q).includes("rotterdam")) {
        routeType = "municipal";
        municipality = q.match(/(amsterdam|utrecht|rotterdam)/i)?.[0];
      } else if (normalize(q).includes("terras")) {
        routeType = "municipal";
      }
    }

    if (routeType === "municipal" && !municipality) {
      if (sessionId) {
        pendingStore.set(sessionId, {
          question: q,
          type: "municipal",
          createdAt: Date.now()
        });
      }
      return res.status(200).json({
        answer: "Voor welke gemeente geldt dit?",
        sources: []
      });
    }

    // -------------------------
    // SEARCH
    // -------------------------

    let sources = [];

    if (routeType === "municipal" && municipality) {

      const keywords = extractKeywords(q);
      const searchQuery =
        `publicatieNaam="Gemeenteblad" AND "${municipality}" AND "${keywords}"`;

      const url =
        "https://zoek.officielebekendmakingen.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve&x-connection=oep&recordSchema=dc" +
        "&maximumRecords=20&startRecord=1" +
        "&query=" + encodeURIComponent(searchQuery);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

      sources = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://zoek.officielebekendmakingen.nl/${id}.html`,
        type: "Gemeenteblad"
      }));

    } else {
      // landelijke fallback
      const bwbQuery = `overheidbwb.titel any "${q}"`;

      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve&x-connection=BWB" +
        "&maximumRecords=8&startRecord=1" +
        "&query=" + encodeURIComponent(bwbQuery);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

      sources = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://wetten.overheid.nl/${id}`,
        type: "BWB"
      }));
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
