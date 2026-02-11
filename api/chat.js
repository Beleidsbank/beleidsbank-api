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

    // =====================================================
    // 1️⃣ AI ROUTER + MUNICIPALITY DETECTION
    // =====================================================

    const routerResp = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `
Analyseer de vraag.

Geef JSON terug:
{
  "type": "national | municipal_regulation | municipal_decision",
  "municipality": "naam of null"
}

Als er geen gemeente wordt genoemd, zet municipality op null.
`
            },
            { role: "user", content: q }
          ]
        })
      }
    );

    let routeType = "national";
    let municipality = null;

    try {
      const routerData = await routerResp.json();
      const parsed = JSON.parse(routerData.choices[0].message.content);
      routeType = parsed.type;
      municipality = parsed.municipality;
    } catch {
      routeType = "national";
      municipality = null;
    }

    // =====================================================
    // 2️⃣ ALS GEMEENTE NODIG IS MAAR ONTBREEKT → VRAAG TERUG
    // =====================================================

    if (
      (routeType === "municipal_regulation" ||
        routeType === "municipal_decision") &&
      !municipality
    ) {
      return res.status(200).json({
        answer: "Voor welke gemeente geldt dit?",
        sources: []
      });
    }

    // =====================================================
    // 3️⃣ GERichte ZOEK
    // =====================================================

    let results = [];

    // -------- NATIONAL --------
    if (routeType === "national") {

      const query = `overheidbwb.titel any "${q}"`;

      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=BWB" +
        "&maximumRecords=5" +
        "&query=" + encodeURIComponent(query);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

      results = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://wetten.overheid.nl/${id}`
      }));
    }

    // -------- MUNICIPAL REGULATION --------
    if (routeType === "municipal_regulation") {

      const query = `dcterms.title any "${q}" AND overheid.organisatie = "${municipality}"`;

      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=CVDR" +
        "&maximumRecords=5" +
        "&query=" + encodeURIComponent(query);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

      results = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://lokaleregelgeving.overheid.nl/${id}`
      }));
    }

    // -------- MUNICIPAL DECISION --------
    if (routeType === "municipal_decision") {

      const query = `publicatieNaam="Gemeenteblad" AND titel any "${q}" AND gemeente="${municipality}"`;

      const url =
        "https://zoek.officielebekendmakingen.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=oep&recordSchema=dc" +
        "&maximumRecords=5" +
        "&query=" + encodeURIComponent(query);

      const resp = await fetchWithTimeout(url);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

      results = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://zoek.officielebekendmakingen.nl/${id}.html`
      }));
    }

    if (!results.length) {
      return res.status(200).json({
        answer: "Geen officiële bronnen gevonden.",
        sources: []
      });
    }

    // Deduplicate
    const unique = [];
    const seen = new Set();

    for (const r of results) {
      if (!seen.has(r.link)) {
        seen.add(r.link);
        unique.push(r);
      }
    }

    const topSources = unique.slice(0, 4);

    const sourcesText = topSources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}`)
      .join("\n\n");

    // =====================================================
    // 4️⃣ ANTWOORD GENEREREN
    // =====================================================

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
      }
    );

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
