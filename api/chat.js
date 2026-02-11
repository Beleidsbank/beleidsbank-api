// -----------------------------
// Rate limiter
// -----------------------------
const rateStore = new Map();

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

export default async function handler(req, res) {

  // -----------------------------
  // CORS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "https://app.beleidsbank.nl");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { message } = req.body || {};
  const q = (message || "").trim();
  if (!q) return res.status(400).json({ error: "Missing message" });

  const fetchWithTimeout = async (url, ms = 12000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

  const pickAll = (text, re) => [...text.matchAll(re)].map(m => m[1]);

  try {

    const cleaned = q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
    const keywords = cleaned.split(/\s+/).filter(w => w.length >= 4).slice(0, 6);
    const term = keywords.join(" ");

    // -----------------------------
    // BWB
    // -----------------------------
    const bwbPromise = (async () => {
      try {
        const url =
          "https://zoekservice.overheid.nl/sru/Search" +
          "?version=1.2&operation=searchRetrieve" +
          "&x-connection=BWB" +
          "&maximumRecords=5&startRecord=1" +
          "&query=" + encodeURIComponent(`overheidbwb.titel any "${term}"`);

        const resp = await fetchWithTimeout(url);
        const xml = await resp.text();

        const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
        const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

        return ids.map((id, i) => ({
          title: titles[i] || id,
          link: `https://wetten.overheid.nl/${id}`,
          type: "BWB"
        }));
      } catch {
        return [];
      }
    })();

    // -----------------------------
    // CVDR
    // -----------------------------
    const cvdrPromise = (async () => {
      try {
        const url =
          "https://zoekservice.overheid.nl/sru/Search" +
          "?version=1.2&operation=searchRetrieve" +
          "&x-connection=CVDR" +
          "&maximumRecords=5&startRecord=1" +
          "&query=" + encodeURIComponent(`keyword all "${term}"`);

        const resp = await fetchWithTimeout(url);
        const xml = await resp.text();

        const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
        const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

        return ids.map((id, i) => ({
          title: titles[i] || id,
          link: `https://lokaleregelgeving.overheid.nl/${id}`,
          type: "CVDR"
        }));
      } catch {
        return [];
      }
    })();

    // -----------------------------
    // OEP
    // -----------------------------
    const oepPromise = (async () => {
      try {
        const url =
          "https://zoek.officielebekendmakingen.nl/sru/Search" +
          "?version=1.2&operation=searchRetrieve" +
          "&x-connection=oep&recordSchema=dc" +
          "&maximumRecords=5&startRecord=1" +
          "&query=" + encodeURIComponent(`keyword all "${term}"`);

        const resp = await fetchWithTimeout(url);
        const xml = await resp.text();

        const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
        const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

        return ids.map((id, i) => ({
          title: titles[i] || id,
          link: `https://zoek.officielebekendmakingen.nl/${id}.html`,
          type: "OEP"
        }));
      } catch {
        return [];
      }
    })();

    // Parallel uitvoeren
    const [bwb, cvdr, oep] = await Promise.all([
      bwbPromise,
      cvdrPromise,
      oepPromise
    ]);

    let allSources = [...bwb, ...cvdr, ...oep];

    // -----------------------------
    // Scoring
    // -----------------------------
    allSources = allSources.map(s => {
      const score = keywords.reduce((acc, k) =>
        s.title.toLowerCase().includes(k) ? acc + 1 : acc, 0);
      return { ...s, score };
    });

    allSources.sort((a, b) => b.score - a.score);

    const topSources = allSources.slice(0, 4);

    if (!topSources.length) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden.",
        sources: []
      });
    }

    const sourcesText = topSources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}`)
      .join("\n\n");

    // -----------------------------
    // OpenAI
    // -----------------------------
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
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
Gebruik uitsluitend de aangeleverde officiële bronnen.
Geef:
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
    });

    const aiData = await aiResp.json();
    const answer = aiData?.choices?.[0]?.message?.content?.trim();

    return res.status(200).json({
      answer: answer || "Geen antwoord gegenereerd.",
      sources: topSources
    });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
