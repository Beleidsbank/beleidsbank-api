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
  // 1-3 woorden, letters/spaties/-/'. toegestaan
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;
  return /^[\p{L}\s.'-]+$/u.test(t);
}

function normalize(s) {
  return (s || "").toLowerCase();
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

function stripSourcesFromAnswer(answer) {
  const a = (answer || "").trim();
  if (!a) return a;
  const low = a.toLowerCase();
  const idx = low.indexOf("\nbronnen:");
  if (idx !== -1) return a.slice(0, idx).trim();
  const idx2 = low.indexOf("bronnen:");
  if (idx2 !== -1 && (idx2 === 0 || a[idx2 - 1] === "\n")) return a.slice(0, idx2).trim();
  return a;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://app.beleidsbank.nl");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const { message, session_id } = req.body || {};
  let q = (message || "").toString().trim();
  const sessionId = (session_id || "").toString().trim();

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
    // 1) Gemeente “follow-up” flow via session
    // -------------------------
    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const fresh = pending && (Date.now() - pending.createdAt) < 5 * 60 * 1000;

    let municipality = null;

    // Als dit een gemeente-antwoord is (bv "Amsterdam") en we hadden pending vraag
    if (fresh && looksLikeMunicipality(q)) {
      municipality = q.trim();
      q = pending.question; // herstel originele vraag
      pendingStore.delete(sessionId);
    }

    // Als het lijkt op een gemeentelijke vraag en we hebben nog geen gemeente: vraag erom
    const qLc = normalize(q);
    const municipalHint =
      qLc.includes("terras") ||
      qLc.includes("apv") ||
      qLc.includes("parkeervergunning") ||
      qLc.includes("vergunning") ||
      qLc.includes("horeca") ||
      qLc.includes("standplaats") ||
      qLc.includes("evenement") ||
      qLc.includes("bouw") ||
      qLc.includes("omgevingsvergunning");

    if (municipalHint && !municipality) {
      if (sessionId) pendingStore.set(sessionId, { question: q, createdAt: Date.now() });
      return res.status(200).json({ answer: "Voor welke gemeente geldt dit?", sources: [] });
    }

    // -------------------------
    // 2) Bronnen zoeken
    //    -> Gemeentelijk: CVDR via zoekdienst.overheid.nl (creator=gemeente)
    // -------------------------
    let sources = [];

    const cvdrSearch = async (municipalityName, topicWords) => {
      // Belangrijk: gebruik zoekdienst.overheid.nl en creator="Gemeente"
      const base = "https://zoekdienst.overheid.nl/sru/Search";
      const creatorsToTry = [
        municipalityName,
        `Gemeente ${municipalityName}`,
        `gemeente ${municipalityName}`
      ];

      for (const creator of creatorsToTry) {
        // CQL: (dcterms.creator="X") AND (keyword all "..." )
        const cql = `(dcterms.creator="${creator}") AND (keyword all "${topicWords}")`;

        const url =
          `${base}?version=1.2` +
          `&operation=searchRetrieve` +
          `&x-connection=cvdr` +
          `&x-info-1-accept=any` +
          `&maximumRecords=20` +
          `&startRecord=1` +
          `&query=${encodeURIComponent(cql)}`;

        const resp = await fetchWithTimeout(url, {}, 15000);
        const xml = await resp.text();

        const ids = pickAll(xml, /<dcterms:identifier>(CVDR[0-9_]+)<\/dcterms:identifier>/g);
        const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

        const items = ids.map((id, i) => ({
          title: titles[i] || id,
          link: `https://lokaleregelgeving.overheid.nl/${id}`,
          type: "CVDR"
        }));

        const uniq = dedupeByLink(items);
        if (uniq.length) return uniq;
      }

      return [];
    };

    const oepSearch = async (municipalityName, topicWords) => {
      const base = "https://zoek.officielebekendmakingen.nl/sru/Search";
      // minder streng: keyword all "Amsterdam terras"
      const cql = `publicatieNaam="Gemeenteblad" AND keyword all "${municipalityName} ${topicWords}"`;

      const url =
        `${base}?version=1.2` +
        `&operation=searchRetrieve` +
        `&x-connection=oep` +
        `&recordSchema=dc` +
        `&maximumRecords=20` +
        `&startRecord=1` +
        `&query=${encodeURIComponent(cql)}`;

      const resp = await fetchWithTimeout(url, {}, 15000);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<dcterms:title>(.*?)<\/dcterms:title>/g);

      const items = ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://zoek.officielebekendmakingen.nl/${id}.html`,
        type: "OEP (Gemeenteblad)"
      }));

      return dedupeByLink(items);
    };

    if (municipality) {
      // 1) APV / algemene regels
      sources = await cvdrSearch(municipality, "algemene plaatselijke verordening OR APV");

      // 2) Specifiek: terras/terrassen/horeca/uitstallingen
      if (!sources.length) {
        sources = await cvdrSearch(municipality, "terras OR terrassen OR horeca OR uitstallingen");
      }

      // 3) Fallback: OEP gemeenteblad besluiten
      if (!sources.length) {
        sources = await oepSearch(municipality, "terras OR terrassen OR horeca");
      }

      // Geen landelijke fallback hier — anders krijg je weer BWBR rommel.
    } else {
      // Landelijk (als het geen gemeentelijke hint was)
      const bwbQuery = `overheidbwb.titel any "${q}"`;
      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve&x-connection=BWB" +
        "&maximumRecords=8&startRecord=1" +
        "&query=" + encodeURIComponent(bwbQuery);

      const resp = await fetchWithTimeout(url, {}, 15000);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

      sources = dedupeByLink(ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://wetten.overheid.nl/${id}`,
        type: "BWB"
      })));
    }

    sources = sources.slice(0, 4);

    if (!sources.length) {
      return res.status(200).json({
        answer:
          "Geen officiële bronnen gevonden. Probeer een concretere term (bv. ‘terrasvergunning’ of ‘APV’).",
        sources: []
      });
    }

    // -------------------------
    // 3) AI antwoord (zonder bronnenlijst)
    // -------------------------
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY ontbreekt.", sources });
    }

    const sourcesText = sources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\nType: ${s.type}\n${s.link}`)
      .join("\n\n");

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
          max_tokens: 420,
          messages: [
            {
              role: "system",
              content: `
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen.
Geef:
1) Kort antwoord (max 4 zinnen)
2) Toelichting (alleen uit bronnen)
Geef GEEN aparte bronnenlijst.
Als bronnen het niet beantwoorden: zeg dat expliciet.
`
            },
            { role: "user", content: `Vraag:\n${q}\n\nOfficiële bronnen:\n${sourcesText}` }
          ]
        })
      },
      20000
    );

    const aiRaw = await aiResp.text();
    let aiData = {};
    try { aiData = JSON.parse(aiRaw); } catch {}

    let answer = aiData?.choices?.[0]?.message?.content?.trim() || "Geen antwoord gegenereerd.";
    answer = stripSourcesFromAnswer(answer);

    return res.status(200).json({ answer, sources });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
