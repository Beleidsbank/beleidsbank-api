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

  // ---------------- CORS ----------------
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

    const cleaned = q.toLowerCase();
    const keywords = cleaned.split(/\s+/).filter(w => w.length >= 4).slice(0, 6);
    const term = keywords.join(" ");

    const scoreSource = (title) => {
      let score = 0;
      const lower = title.toLowerCase();

      keywords.forEach(k => {
        if (lower.includes(k)) score += 2;
      });

      if (cleaned.includes("apv") && lower.includes("apv")) score += 3;
      if (cleaned.includes("wet") && lower.includes("wet")) score += 3;

      const yearMatch = cleaned.match(/\b(20\d{2})\b/);
      if (yearMatch && lower.includes(yearMatch[1])) score += 2;

      return score;
    };

    const search = async (urlBuilder, type, linkBuilder) => {
      try {
        const url = urlBuilder(term);
        const resp = await fetchWithTimeout(url);
        const xml = await resp.text();

        const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
        const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

        return ids.map((id, i) => ({
          title: titles[i] || id,
          link: linkBuilder(id),
          type
        }));
      } catch {
        return [];
      }
    };

    const [bwb, cvdr, oep] = await Promise.all([

      search(
        term => `https://zoekservice.overheid.nl/sru/Search?version=1.2&operation=searchRetrieve&x-connection=BWB&maximumRecords=5&query=${encodeURIComponent(`overheidbwb.titel any "${term}"`)}`,
        "BWB",
        id => `https://wetten.overheid.nl/${id}`
      ),

      search(
        term => `https://zoekservice.overheid.nl/sru/Search?version=1.2&operation=searchRetrieve&x-connection=CVDR&maximumRecords=5&query=${encodeURIComponent(`keyword all "${term}"`)}`,
        "CVDR",
        id => `https://lokaleregelgeving.overheid.nl/${id}`
      ),

      search(
        term => `https://zoek.officielebekendmakingen.nl/sru/Search?version=1.2&operation=searchRetrieve&x-connection=oep&recordSchema=dc&maximumRecords=5&query=${encodeURIComponent(`keyword all "${term}"`)}`,
        "OEP",
        id => `https://zoek.officielebekendmakingen.nl/${id}.html`
      )
    ]);

    // Combine + deduplicate
    const all = [...bwb, ...cvdr, ...oep];
    const unique = [];
    const seen = new Set();

    for (const s of all) {
      if (!seen.has(s.link)) {
        seen.add(s.link);
        unique.push({ ...s, score: scoreSource(s.title) });
      }
    }

    unique.sort((a, b) => b.score - a.score);
    const topSources = unique.slice(0, 4);

    if (!topSources.length) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden.",
        sources: []
      });
    }

    const sourcesText = topSources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}`)
      .join("\n\n");

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
Gebruik uitsluitend de aangeleverde bronnen.
Geef:
1. Kort antwoord
2. Toelichting
Geef GEEN aparte bronnenlijst.
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

  } catch {
    return res.status(500).json({ error: "Interne fout" });
  }
}
