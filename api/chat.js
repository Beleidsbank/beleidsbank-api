// -----------------------------
// Simple in-memory rate limiter (best effort on serverless)
// -----------------------------
const rateStore = new Map();
/**
 * limit: max requests per windowMs per IP
 */
function rateLimit(ip, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const item = rateStore.get(ip) || { count: 0, resetAt: now + windowMs };

  // reset window
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + windowMs;
  }

  item.count += 1;
  rateStore.set(ip, item);

  const remaining = Math.max(0, limit - item.count);
  return { ok: item.count <= limit, remaining, resetAt: item.resetAt };
}

export default async function handler(req, res) {
  // -----------------------------
  // CORS: alleen jouw site toestaan
  // -----------------------------
  const allowedOrigins = new Set([
    "https://beleidsbank.nl",
    "https://www.beleidsbank.nl"
  ]);

  const origin = req.headers.origin || "";
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // Als request niet vanaf jouw site komt, blokkeren (basic anti-abuse)
  // (Let op: curl/postman heeft geen Origin -> die blokken we ook)
  if (!allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Forbidden (origin not allowed)" });
  }

  // -----------------------------
  // Rate limit per IP
  // -----------------------------
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const rl = rateLimit(ip, 10, 60_000); // 10 per minuut
  res.setHeader("X-RateLimit-Limit", "10");
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));

  if (!rl.ok) {
    return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  }

  const { message } = req.body || {};

  // timeout helper
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
    // Maak zoekwoorden
    const cleaned = (message || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    const stopwords = new Set([
      "wat","wanneer","is","de","het","een","rond","over","in","op",
      "van","en","voor","beleid","wet","wordt","zijn","met","hoe","waarom"
    ]);

    const keywords = cleaned
      .split(" ")
      .filter(w => w.length >= 3 && !stopwords.has(w))
      .slice(0, 6);

    const term = keywords.length ? keywords.join(" ") : cleaned;

    // 1) BWB (wetten) – eerst proberen
    const bwbSearch = async () => {
      const bwbQuery = `overheidbwb.titel any "${term}"`;

      const bwbUrl =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2" +
        "&operation=searchRetrieve" +
        "&x-connection=BWB" +
        "&maximumRecords=8" +
        "&startRecord=1" +
        "&query=" + encodeURIComponent(bwbQuery);

      const resp = await fetchWithTimeout(bwbUrl, {}, 12000);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

      if (!ids.length) return null;

      // dedupe
      const uniq = [];
      const seen = new Set();
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (seen.has(id)) continue;
        seen.add(id);

        uniq.push({
          title: titles[i] || `Regeling ${id}`,
          link: `https://wetten.overheid.nl/${id}`,
          type: "BWB (wet/regeling)"
        });

        if (uniq.length >= 3) break;
      }

      return { sources: uniq };
    };

    // 2) OEP fallback
    const oepSearch = async () => {
      const sruQuery = `keyword all "${term}"`;

      const oepUrl =
        "https://zoek.officielebekendmakingen.nl/sru/Search" +
        "?version=1.2" +
        "&operation=searchRetrieve" +
        "&x-connection=oep" +
        "&recordSchema=dc" +
        "&maximumRecords=12" +
        "&startRecord=1" +
        "&query=" + encodeURIComponent(sruQuery);

      const resp = await fetchWithTimeout(oepUrl, {}, 12000);
      const xml = await resp.text();

      const titlesAll = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);
      const idsAll = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
      const typesAll = pickAll(xml, /<dcterms:type[^>]*scheme="overheidop:([^"]+)"[^>]*>.*?<\/dcterms:type>/g);

      const blockedTypes = new Set(["Gemeenteblad", "Provinciaalblad", "Waterschapsblad"]);

      const records = [];
      const n = Math.min(titlesAll.length, idsAll.length);
      for (let i = 0; i < n; i++) {
        const title = titlesAll[i];
        const id = idsAll[i];
        const type = typesAll[i] || "";
        if (blockedTypes.has(type)) continue;

        const titleLc = (title || "").toLowerCase();
        const hit = keywords.some(k => titleLc.includes(k));
        const score = hit ? 1 : 0;

        records.push({
          title,
          link: `https://zoek.officielebekendmakingen.nl/${id}.html`,
          type: type || "OEP",
          score
        });
      }

      records.sort((a, b) => b.score - a.score);

      const sources = records.slice(0, 4).map(r => ({
        title: r.title,
        link: r.link,
        type: r.type
      }));

      if (!sources.length) return null;
      return { sources };
    };

    let picked = await bwbSearch();
    if (!picked) picked = await oepSearch();

    if (!picked || !picked.sources || picked.sources.length === 0) {
      return res.status(200).json({
        answer:
          "Ik kon geen betrouwbare officiële bronnen vinden voor deze vraag. Probeer een concretere wet/regelingnaam of een andere zoekterm.",
        sources: []
      });
    }

    const sourcesText = picked.sources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}\n`)
      .join("\n");

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
          max_tokens: 380,
          messages: [
            {
              role: "system",
              content: `
Je bent Beleidsbank.nl (v1 landelijk).
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen.
Noem waar mogelijk artikel/hoofdstuk/paragraaf als dat in de bron zichtbaar is; anders zeg je dat het niet zichtbaar is.
Verzin niets en gebruik geen eigen kennis.
Als de bronnen de vraag niet beantwoorden: zeg dat expliciet.

Structuur:
1) Kort antwoord (max 4 zinnen)
2) Toelichting (alleen uit bronnen)
3) Bronnen (genummerd, met link)
`
            },
            { role: "user", content: `Vraag:\n${message}\n\nOfficiële bronnen:\n${sourcesText}` }
          ]
        })
      },
      20000
    );

    const aiData = await aiResp.json();
    const answer =
      aiData?.choices?.[0]?.message?.content ||
      "Er ging iets mis bij het genereren van het antwoord.";

    // Minimal logging
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      ip,
      q_len: (message || "").length,
      sources: picked.sources.map(s => s.link).slice(0, 4)
    }));

    return res.status(200).json({ answer, sources: picked.sources });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout bij Beleidsbank" });
  }
}
