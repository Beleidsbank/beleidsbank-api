// -----------------------------
// Simple in-memory rate limiter
// -----------------------------
const rateStore = new Map();

function rateLimit(ip, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const item = rateStore.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + windowMs;
  }

  item.count += 1;
  rateStore.set(ip, item);

  return { ok: item.count <= limit };
}

export default async function handler(req, res) {

  const allowedOrigins = new Set([
    "https://app.beleidsbank.nl"
  ]);

  const origin = req.headers.origin || "";
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
  return res.status(200).end();
}

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });
  if (!allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip).ok) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { message } = req.body || {};
  const q = (message || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing message" });

  const fetchWithTimeout = async (url, options = {}, ms = 12000) => {
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

    const cleaned = q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
    const keywords = cleaned.split(/\s+/).filter(w => w.length >= 4).slice(0, 6);
    const term = keywords.length ? keywords.join(" ") : cleaned;

    // -----------------------------
    // CVDR (gemeentelijke regelingen)
    // -----------------------------
    const cvdrSearch = async () => {
      const query = `keyword all "${term}"`;

      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=CVDR" +
        "&maximumRecords=6&startRecord=1" +
        "&query=" + encodeURIComponent(query);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);
      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);

      if (!ids.length) return null;

      const sources = [];
      const seen = new Set();

      for (let i = 0; i < ids.length; i++) {
        if (seen.has(ids[i])) continue;
        seen.add(ids[i]);

        sources.push({
          title: titles[i] || ids[i],
          link: `https://lokaleregelgeving.overheid.nl/${ids[i]}`,
          type: "CVDR"
        });

        if (sources.length >= 3) break;
      }

      return sources.length ? { sources } : null;
    };

    // -----------------------------
    // OEP (Gemeenteblad etc.)
    // -----------------------------
    const oepSearch = async () => {

      const query = `keyword all "${term}"`;

      const url =
        "https://zoek.officielebekendmakingen.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=oep&recordSchema=dc" +
        "&maximumRecords=8&startRecord=1" +
        "&query=" + encodeURIComponent(query);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);
      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);

      if (!ids.length) return null;

      const sources = [];

      for (let i = 0; i < Math.min(4, ids.length); i++) {
        sources.push({
          title: titles[i] || ids[i],
          link: `https://zoek.officielebekendmakingen.nl/${ids[i]}.html`,
          type: "OEP"
        });
      }

      return sources.length ? { sources } : null;
    };

    // -----------------------------
    // BWB (landelijke wetgeving)
    // -----------------------------
    const bwbSearch = async () => {

      const query = `overheidbwb.titel any "${term}"`;

      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=BWB" +
        "&maximumRecords=6&startRecord=1" +
        "&query=" + encodeURIComponent(query);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

      if (!ids.length) return null;

      const sources = [];

      for (let i = 0; i < Math.min(3, ids.length); i++) {
        sources.push({
          title: titles[i] || ids[i],
          link: `https://wetten.overheid.nl/${ids[i]}`,
          type: "BWB"
        });
      }

      return sources.length ? { sources } : null;
    };

    // -----------------------------
    // Zoekvolgorde
    // -----------------------------
    let picked = await oepSearch();
if (!picked) picked = await bwbSearch();


    if (!picked) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden.",
        sources: []
      });
    }

    const sourcesText = picked.sources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}`)
      .join("\n\n");

    // -----------------------------
    // OpenAI
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
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: `
Je bent Beleidsbank.nl.
Je antwoordt uitsluitend op basis van de aangeleverde officiële bronnen.
Structuur:
1. Kort antwoord
2. Toelichting
3. Bronnen
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
    const answer = aiData?.choices?.[0]?.message?.content?.trim();

    return res.status(200).json({
      answer: answer || "Geen antwoord gegenereerd.",
      sources: picked.sources
    });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
