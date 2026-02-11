const rateStore = new Map();

// Bewaar "openstaande vraag" per IP (best-effort op serverless)
const pendingStore = new Map(); // ip -> { question, type, createdAt }

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

  // max 3 woorden, geen rare tekens, niet te lang
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;
  if (t.length > 40) return false;
  if (!/^[\p{L}\s.'-]+$/u.test(t)) return false; // alleen letters/spaties/.-'
  // minimaal 2 letters
  if (t.replace(/\s+/g, "").length < 2) return false;

  return true;
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
  let q = (message || "").toString().trim();
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
    // 0) "Gemeente-antwoord" afhandelen (context onthouden)
    // =====================================================
    const pending = pendingStore.get(ip);
    const now = Date.now();
    const pendingIsFresh = pending && (now - pending.createdAt) < 5 * 60 * 1000; // 5 min

    if (pendingIsFresh && looksLikeMunicipality(q)) {
      // gebruiker heeft alleen gemeente gestuurd, plak die op de openstaande vraag
      const municipality = q.trim();
      q = `${pending.question} (gemeente: ${municipality})`;

      // zet voor deze request de routeType vast op de pending type
      // en geef municipality mee in variabele
      var forcedRouteType = pending.type;
      var forcedMunicipality = municipality;

      // pending opgelost
      pendingStore.delete(ip);
    }

    // =====================================================
    // 1) AI ROUTER + gemeente-extractie
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
Analyseer de vraag en geef strikt JSON terug:

{
  "type": "national | municipal_regulation | municipal_decision",
  "municipality": "naam of null"
}

- national: landelijke wet- en regelgeving (BWB / wetten.overheid.nl)
- municipal_regulation: gemeentelijke verordeningen/beleidsregels (CVDR / lokaleregelgeving)
- municipal_decision: gemeentelijke bekendmakingen/besluiten (OEP / Gemeenteblad)

Als geen gemeente genoemd: municipality = null.
`
            },
            { role: "user", content: q }
          ]
        })
      },
      12000
    );

    let routeType = "national";
    let municipality = null;

    try {
      const routerData = await routerResp.json();
      const parsed = JSON.parse(routerData?.choices?.[0]?.message?.content || "{}");
      routeType = parsed.type || "national";
      municipality = parsed.municipality || null;
    } catch {
      routeType = "national";
      municipality = null;
    }

    // Als we eerder forcedRouteType/municipality hadden (gemeente-reply), override
    if (typeof forcedRouteType !== "undefined") routeType = forcedRouteType;
    if (typeof forcedMunicipality !== "undefined") municipality = forcedMunicipality;

    // =====================================================
    // 2) Als gemeente nodig is maar ontbreekt → vraag terug + onthoud pending
    // =====================================================
    if (
      (routeType === "municipal_regulation" || routeType === "municipal_decision") &&
      !municipality
    ) {
      pendingStore.set(ip, { question: q, type: routeType, createdAt: Date.now() });

      return res.status(200).json({
        answer: "Voor welke gemeente geldt dit?",
        sources: []
      });
    }

    // =====================================================
    // 3) Gerichte zoek (met betrouwbare post-filter op creator)
    // =====================================================
    const cleaned = q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
    const keywords = cleaned.split(/\s+/).filter(w => w.length >= 4).slice(0, 8);
    const term = keywords.join(" ").trim() || cleaned.trim();

    const normalize = (s) => (s || "").toLowerCase();
    const munLc = normalize(municipality || "");

    const dedupeByLink = (arr) => {
      const seen = new Set();
      const out = [];
      for (const s of arr) {
        if (!s?.link) continue;
        if (seen.has(s.link)) continue;
        seen.add(s.link);
        out.push(s);
      }
      return out;
    };

    const scoreTitle = (title) => {
      const t = normalize(title);
      let score = 0;
      for (const k of keywords) {
        if (t.includes(k)) score += 2;
      }
      // kleine boosts
      if (t.includes("algemene plaatselijke verordening")) score += 3;
      if (t.includes("apv")) score += 3;
      if (t.includes("verkeersbesluit")) score += 2;

      const year = (q.match(/\b(20\d{2})\b/) || [])[1];
      if (year && t.includes(year)) score += 2;

      // als municipality in titel voorkomt
      if (munLc && t.includes(munLc)) score += 2;

      return score;
    };

    const bwbSearch = async () => {
      const bwbQuery = `overheidbwb.titel any "${q}"`;
      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=BWB" +
        "&maximumRecords=8&startRecord=1" +
        "&query=" + encodeURIComponent(bwbQuery);

      const resp = await fetchWithTimeout(url, {}, 12000);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

      const sources = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://wetten.overheid.nl/${id}`,
        type: "BWB"
      }));

      return dedupeByLink(sources).slice(0, 6);
    };

    const cvdrSearch = async () => {
      // Zoek vooral in TITELS om ruis te beperken
      const cvdrQuery = `dcterms.title any "${q}"`;
      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=CVDR" +
        "&maximumRecords=12&startRecord=1" +
        "&query=" + encodeURIComponent(cvdrQuery);

      const resp = await fetchWithTimeout(url, {}, 12000);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);
      const creators = pickAll(xml, /<dcterms:creator>(.*?)<\/dcterms:creator>/g);

      let sources = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://lokaleregelgeving.overheid.nl/${id}`,
        type: "CVDR",
        _creator: creators[i] || ""
      }));

      if (munLc) {
        sources = sources.filter(s => {
          const c = normalize(s._creator);
          return c.includes(munLc) || c.includes(`gemeente ${munLc}`);
        });
      }

      sources = sources.map(s => ({ ...s, score: scoreTitle(s.title) }))
                       .sort((a, b) => b.score - a.score);

      return dedupeByLink(sources).slice(0, 6).map(({ _creator, score, ...rest }) => rest);
    };

    const oepSearch = async () => {
      // Forceer Gemeenteblad in de query (vermindert ruis enorm)
      const oepQuery = `publicatieNaam="Gemeenteblad" AND (titel any "${q}")`;

      const url =
        "https://zoek.officielebekendmakingen.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve" +
        "&x-connection=oep&recordSchema=dc" +
        "&maximumRecords=12&startRecord=1" +
        "&query=" + encodeURIComponent(oepQuery);

      const resp = await fetchWithTimeout(url, {}, 12000);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);
      const creators = pickAll(xml, /<dcterms:creator>(.*?)<\/dcterms:creator>/g);

      let sources = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://zoek.officielebekendmakingen.nl/${id}.html`,
        type: "OEP",
        _creator: creators[i] || ""
      }));

      if (munLc) {
        sources = sources.filter(s => {
          const c = normalize(s._creator);
          return c.includes(munLc) || c.includes(`gemeente ${munLc}`);
        });
      }

      sources = sources.map(s => ({ ...s, score: scoreTitle(s.title) }))
                       .sort((a, b) => b.score - a.score);

      return dedupeByLink(sources).slice(0, 6).map(({ _creator, score, ...rest }) => rest);
    };

    // Welke zoekbron gebruiken?
    let sources = [];
    if (routeType === "national") {
      sources = await bwbSearch();
      // fallback: als BWB niets vindt, probeer OEP (soms Kamerstukken/moties etc.)
      if (!sources.length) sources = await oepSearch();
    } else if (routeType === "municipal_regulation") {
      sources = await cvdrSearch();
      if (!sources.length) sources = await oepSearch();
      if (!sources.length) sources = await bwbSearch();
    } else if (routeType === "municipal_decision") {
      sources = await oepSearch();
      if (!sources.length) sources = await cvdrSearch();
      if (!sources.length) sources = await bwbSearch();
    } else {
      // fallback
      sources = await bwbSearch();
      if (!sources.length) sources = await cvdrSearch();
      if (!sources.length) sources = await oepSearch();
    }

    if (!sources.length) {
      return res.status(200).json({ answer: "Geen officiële bronnen gevonden.", sources: [] });
    }

    // top 4 bronnen
    const topSources = sources.slice(0, 4);

    const sourcesText = topSources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}`)
      .join("\n\n");

    // =====================================================
    // 4) Antwoord genereren (zonder bronnenlijst)
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
1) Kort antwoord
2) Toelichting
Geef GEEN aparte bronnenlijst.
Als de bronnen de vraag niet beantwoorden: zeg dat expliciet.
`
            },
            { role: "user", content: `Vraag:\n${q}\n\nBronnen:\n${sourcesText}` }
          ]
        })
      },
      20000
    );

    const aiRaw = await aiResp.text();
    let aiData = {};
    try { aiData = JSON.parse(aiRaw); } catch {}

    const answer = aiData?.choices?.[0]?.message?.content?.trim();

    return res.status(200).json({
      answer: answer || "Geen antwoord gegenereerd.",
      sources: topSources
    });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
