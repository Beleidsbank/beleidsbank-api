// -----------------------------
// Rate limiter + session store
// -----------------------------
const rateStore = new Map();

// Pending per session (niet per IP). Best-effort; maar stabieler omdat client dezelfde session_id stuurt.
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
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;
  if (t.length > 40) return false;
  if (!/^[\p{L}\s.'-]+$/u.test(t)) return false;
  if (t.replace(/\s+/g, "").length < 2) return false;
  return true;
}

function normalize(s) {
  return (s || "").toLowerCase();
}

function extractSearchTermsNL(q) {
  const text = normalize(q).replace(/[^\p{L}\p{N}\s]/gu, " ");
  const stop = new Set([
    "mag","ik","een","de","het","dit","dat","voor","van","in","op","aan","bij","naar",
    "hoe","wat","waar","wanneer","welke","welk","kan","kun","moet","mogen","plaats","plaatsen",
    "gemeente","geldt","betreft","regels","regel","vergunning","aanvragen","nodig","onder","voorwaarden",
    "is","zijn","worden","wordt","ook","nog","dan","als","met","zonder","en","of"
  ]);
  const words = text.split(/\s+/).filter(w => w.length >= 4 && !stop.has(w));
  // Zorg dat we bij terras-vragen altijd “terras” meenemen als het voorkomt
  const hasTerras = text.includes("terras");
  const top = words.slice(0, 6);
  if (hasTerras && !top.includes("terras")) top.unshift("terras");
  return top.join(" ").trim() || (hasTerras ? "terras" : text.trim());
}

function stripSourcesFromAnswer(answer) {
  const a = (answer || "").trim();
  if (!a) return a;
  // knip alles weg vanaf een "Bronnen:" kop (AI wil dat soms toch toevoegen)
  const idx = a.toLowerCase().indexOf("\nbronnen:");
  if (idx !== -1) return a.slice(0, idx).trim();
  const idx2 = a.toLowerCase().indexOf("bronnen:");
  // als bronnen: middenin staat op nieuwe regel of begin
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
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const { message, session_id } = req.body || {};
  let q = (message || "").toString().trim();
  const sessionId = (session_id || "").toString().trim();

  if (!q) return res.status(400).json({ error: "Missing message" });
  if (!sessionId) {
    // We ondersteunen session_id; zonder session_id blijft het werken maar municipality-followup is instabiel.
    // We geven wel antwoord, maar vragen om municipality kan dan weer stuk gaan.
  }

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
    // 0) Pending flow (session-based)
    const pending = sessionId ? pendingStore.get(sessionId) : null;
    const now = Date.now();
    const pendingIsFresh = pending && (now - pending.createdAt) < 5 * 60 * 1000;

    let forcedType = null;
    let municipality = null;

    if (pendingIsFresh && looksLikeMunicipality(q)) {
      municipality = q.trim();
      forcedType = pending.type;
      q = pending.question; // originele vraag herstellen
      pendingStore.delete(sessionId);
    }

    // 1) AI router (type + municipality)
    let routeType = "national";

    if (forcedType) {
      routeType = forcedType;
    } else {
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

- municipal_regulation: verordening/beleidsregel/APV (CVDR)
- municipal_decision: bekendmaking/besluit (OEP Gemeenteblad)
- national: landelijke wet/regeling (BWB)

Als geen gemeente genoemd: municipality=null.
`
              },
              { role: "user", content: q }
            ]
          })
        },
        12000
      );

      try {
        const routerData = await routerResp.json();
        const parsed = JSON.parse(routerData?.choices?.[0]?.message?.content || "{}");
        routeType = parsed.type || "national";
        municipality = parsed.municipality || null;
      } catch {
        routeType = "national";
        municipality = null;
      }
    }

    // 2) Gemeente nodig maar ontbreekt → vraag terug + onthoud pending in session
    if ((routeType === "municipal_regulation" || routeType === "municipal_decision") && !municipality) {
      if (sessionId) {
        pendingStore.set(sessionId, { question: q, type: routeType, createdAt: Date.now() });
      }
      return res.status(200).json({
        answer: "Voor welke gemeente geldt dit?",
        sources: [],
        need_municipality: true
      });
    }

    const munLc = normalize(municipality || "");
    const baseTerm = extractSearchTermsNL(q);

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
      for (const k of baseTerm.split(/\s+/).filter(Boolean)) {
        if (t.includes(k)) score += 2;
      }
      if (munLc && t.includes(munLc)) score += 2;
      if (t.includes("apv") || t.includes("algemene plaatselijke verordening")) score += 3;
      if (t.includes("terras") || t.includes("terrassen")) score += 3;
      return score;
    };

    // ---- BWB
    const bwbSearch = async () => {
      const bwbQuery = `overheidbwb.titel any "${q}"`;
      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve&x-connection=BWB" +
        "&maximumRecords=10&startRecord=1" +
        "&query=" + encodeURIComponent(bwbQuery);

      const resp = await fetchWithTimeout(url, {}, 12000);
      const xml = await resp.text();

      const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
      const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

      return dedupeByLink(ids.map((id, i) => ({
        title: titles[i] || id,
        link: `https://wetten.overheid.nl/${id}`,
        type: "BWB"
      }))).slice(0, 6);
    };

    // ---- CVDR (zoeken + creator-filter in response)
    const cvdrSearchMunicipality = async () => {
      const query = munLc
        ? `(dcterms.creator all "${municipality}") AND (keyword all "${baseTerm}")`
        : `keyword all "${baseTerm}"`;

      const url =
        "https://zoekservice.overheid.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve&x-connection=CVDR" +
        "&maximumRecords=25&startRecord=1" +
        "&query=" + encodeURIComponent(query);

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

      sources = sources
        .map(s => ({ ...s, score: scoreTitle(s.title) }))
        .sort((a, b) => b.score - a.score);

      return dedupeByLink(sources)
        .slice(0, 10)
        .map(({ _creator, score, ...rest }) => rest);
    };

    // ---- OEP (Gemeenteblad + creator-filter)
    const oepSearchMunicipality = async () => {
      const query = munLc
        ? `publicatieNaam="Gemeenteblad" AND (dcterms.creator all "${municipality}") AND (keyword all "${baseTerm}")`
        : `publicatieNaam="Gemeenteblad" AND (keyword all "${baseTerm}")`;

      const url =
        "https://zoek.officielebekendmakingen.nl/sru/Search" +
        "?version=1.2&operation=searchRetrieve&x-connection=oep&recordSchema=dc" +
        "&maximumRecords=25&startRecord=1" +
        "&query=" + encodeURIComponent(query);

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

      sources = sources
        .map(s => ({ ...s, score: scoreTitle(s.title) }))
        .sort((a, b) => b.score - a.score);

      return dedupeByLink(sources)
        .slice(0, 10)
        .map(({ _creator, score, ...rest }) => rest);
    };

    // 4) Kies bronnen per route
    let sources = [];

    if (routeType === "national") {
      sources = await bwbSearch();
      // (optioneel) OEP-kamerstukken als fallback kun je later toevoegen, maar voor nu niet nodig
    } else if (routeType === "municipal_regulation") {
      sources = await cvdrSearchMunicipality();
      if (!sources.length) sources = await oepSearchMunicipality();
      // geen BWB fallback voor gemeentelijke vraag
    } else if (routeType === "municipal_decision") {
      sources = await oepSearchMunicipality();
      if (!sources.length) sources = await cvdrSearchMunicipality();
      // geen BWB fallback
    } else {
      // fallback safe
      sources = await bwbSearch();
    }

    if (!sources.length) {
      return res.status(200).json({ answer: "Geen officiële bronnen gevonden.", sources: [] });
    }

    const topSources = sources.slice(0, 4);

    const sourcesText = topSources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}`)
      .join("\n\n");

    // 5) Antwoord genereren (zonder bronnenlijst)
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

    let answer = aiData?.choices?.[0]?.message?.content?.trim() || "";
    answer = stripSourcesFromAnswer(answer);

    return res.status(200).json({
      answer: answer || "Geen antwoord gegenereerd.",
      sources: topSources
    });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
