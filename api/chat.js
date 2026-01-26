export default async function handler(req, res) {
  // CORS (voor WordPress)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { message } = req.body || {};

  const fetchWithTimeout = async (url, options = {}, ms = 12000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

const clientKey = req.headers["x-api-key"];
if (!clientKey || clientKey !== process.env.BELEIDSBANK_API_KEY) {
  return res.status(401).json({ error: "Unauthorized" });
}
  
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

  const keywords = cleaned.split(" ").filter(w => w.length >= 3 && !stopwords.has(w)).slice(0, 6);
  const term = keywords.length ? keywords.join(" ") : cleaned;

  // Helpers om XML velden te pakken
  const pickAll = (text, re) => [...text.matchAll(re)].map(m => m[1]);

  // --------
  // 1) BWB (wetten) – eerst proberen
  // Endpoint: zoekservice.overheid.nl/sru/Search met x-connection=BWB. :contentReference[oaicite:1]{index=1}
  // --------
  const bwbSearch = async () => {
    // BWB ondersteunt o.a. overheidbwb:titel met operators any/all/adj (in docs). :contentReference[oaicite:2]{index=2}
    const bwbQuery = `overheidbwb.titel any "${term}"`;

    const bwbUrl =
      "https://zoekservice.overheid.nl/sru/Search" +
      "?version=1.2" +
      "&operation=searchRetrieve" +
      "&x-connection=BWB" +
      "&maximumRecords=5" +
      "&startRecord=1" +
      "&query=" + encodeURIComponent(bwbQuery);

    const resp = await fetchWithTimeout(bwbUrl, {}, 12000);
    const xml = await resp.text();

    // BWB identifier is meestal BWBR...
    const ids = pickAll(xml, /<dcterms:identifier>(BWBR[0-9A-Z]+)<\/dcterms:identifier>/g);
    const titles = pickAll(xml, /<overheidbwb:titel>(.*?)<\/overheidbwb:titel>/g);

    if (!ids.length) return null;

    // Maak wetten.nl links
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

const sources = uniq;


    return { sources };
  };

  // --------
  // 2) OEP fallback (Staatscourant/Staatsblad)
  // --------
  const oepSearch = async () => {
    const sruQuery = `keyword all "${term}"`;

    const oepUrl =
      "https://zoek.officielebekendmakingen.nl/sru/Search" +
      "?version=1.2" +
      "&operation=searchRetrieve" +
      "&x-connection=oep" +
      "&recordSchema=dc" +
      "&maximumRecords=10" +
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

      // simpele “relevantie”: titel moet minstens 1 keyword bevatten
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

    // sorteer: relevant eerst
    records.sort((a, b) => b.score - a.score);

    const sources = records.slice(0, 4).map(r => ({
      title: r.title,
      link: r.link,
      type: r.type
    }));

    if (!sources.length) return null;
    return { sources };
  };

  // --------
  // 3) Kies bronnen (BWB eerst, dan OEP)
  // --------
  let picked = await bwbSearch();
  if (!picked) picked = await oepSearch();

  if (!picked || !picked.sources || picked.sources.length === 0) {
    return res.status(200).json({
      answer:
        "Ik kon geen betrouwbare officiële bronnen vinden voor deze vraag. Probeer een concretere wet/regelingnaam of een andere zoekterm.",
      sources: []
    });
  }

  // --------
  // 4) AI antwoord op basis van bronnen
  // --------
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
Noem waar mogelijk het artikel/hoofdstuk/paragraaf (als dat in de bron staat). Anders zeg je dat het niet zichtbaar is in de bron.
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

  return res.status(200).json({
    answer,
    sources: picked.sources
  });
}
