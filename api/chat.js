export default async function handler(req, res) {
  // CORS (voor WordPress)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { message, debug } = req.body || {};

  // timeout helper (voorkomt eindeloos “Bezig met laden…”)
  const fetchWithTimeout = async (url, options = {}, ms = 12000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

  // maak van identifier een echte klikbare URL
  const toPublicUrl = (identifier) => {
    // identifiers zoals: gmb-2026-33238, stb-2020-123, stcrt-2024-12345 etc.
    if (!identifier) return "";
    return `https://zoek.officielebekendmakingen.nl/${identifier}.html`;
  };

  try {
    // 1) Zoekterm (keywords)
    const cleaned = (message || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    const stopwords = new Set(["wat","wanneer","is","de","het","een","rond","over","in","op","van","en","voor","beleid","wet","wordt","zijn","met","hoe","waarom"]);
    const keywords = cleaned.split(" ").filter(w => w.length >= 3 && !stopwords.has(w)).slice(0, 6);
    const term = keywords.length ? keywords.join(" ") : cleaned;

    // 2) SRU – OEP (Officiële bekendmakingen)
    // Belangrijk: we halen wat meer op en filteren daarna op landelijk
    const sruUrl =
      "https://zoek.officielebekendmakingen.nl/sru/Search" +
      "?version=1.2" +
      "&operation=searchRetrieve" +
      "&x-connection=oep" +
      "&recordSchema=dc" +
      "&maximumRecords=25" +
      "&startRecord=1" +
      "&query=" + encodeURIComponent(`(keyword all "${term}") and (dcterms.type = Staatscourant or dcterms.type = Staatsblad)`);

    const sruResp = await fetchWithTimeout(sruUrl, {}, 12000);
    const sruText = await sruResp.text();

    // helpers om velden te pakken
    const pickAll = (re) => [...sruText.matchAll(re)].map(m => m[1]);

    // dcterms velden komen daadwerkelijk terug (zoals je debug liet zien)
    const titlesAll = pickAll(/<dcterms:title>(.*?)<\/dcterms:title>/g);
    const idsAll    = pickAll(/<dcterms:identifier>(.*?)<\/dcterms:identifier>/g);

    // type label zit ook in de record XML; we pakken het “menselijke” type (Gemeenteblad/Staatscourant/...)
    const typesAll  = pickAll(/<dcterms:type[^>]*scheme="overheidop:([^"]+)"[^>]*>.*?<\/dcterms:type>/g);

    if (debug) {
      return res.status(200).json({
        sruUrl,
        httpStatus: sruResp.status,
        foundTitles: titlesAll.length,
        foundIds: idsAll.length,
        foundTypes: typesAll.length,
        sample: sruText.slice(0, 1200)
      });
    }

    // 3) Bouw records + filter “niet-landelijk” eruit
    // In v1 willen we NIET: Gemeenteblad / Provinciaal blad / Waterschapsblad
    const blockedTypes = new Set(["Gemeenteblad", "Provinciaalblad", "Waterschapsblad"]);

    const records = [];
    const n = Math.min(titlesAll.length, idsAll.length);
    for (let i = 0; i < n; i++) {
      const title = titlesAll[i];
      const id = idsAll[i];
      const type = typesAll[i] || ""; // kan soms ontbreken
      records.push({ title, id, type, link: toPublicUrl(id) });
    }

    const national = records.filter(r => !blockedTypes.has(r.type)).slice(0, 4);

    // 4) Als er geen landelijke bronnen zijn: STOP (geen AI, snel + geen hallucinatie)
    if (national.length === 0) {
      return res.status(200).json({
        answer:
          "Ik vond alleen lokale publicaties (bijv. Gemeenteblad) bij deze zoekopdracht. Beleidsbank v1 is nu nog alleen landelijk. Probeer een zoekterm als: 'Wet passend onderwijs', 'Staatscourant passend onderwijs', of 'ministeriële regeling passend onderwijs'.",
        sources: []
      });
    }

    // 5) Bronnenblok voor AI
    const sourcesText = national
      .map((s, i) => `Bron ${i + 1}: ${s.title}\nType: ${s.type || "Onbekend"}\n${s.link}\n`)
      .join("\n");

    // 6) OpenAI – strikt bronnen-only + kort (sneller)
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
          max_tokens: 350,
          messages: [
            {
              role: "system",
              content: `
Je bent Beleidsbank.nl (v1 landelijk).
Je mag ALLEEN antwoorden op basis van de aangeleverde bronnen.
Verzin niets en gebruik geen eigen kennis.
Als de bronnen niet genoeg zeggen over de vraag: zeg dat expliciet.

Structuur (verplicht):
1) Kort antwoord (max 4 zinnen)
2) Toelichting (alleen uit bronnen)
3) Bronnen (genummerd, met link)
`
            },
            {
              role: "user",
              content: `Vraag:\n${message}\n\nOfficiële bronnen:\n${sourcesText}`
            }
          ]
        })
      },
      20000
    );

    const aiData = await aiResp.json();
    const answer = aiData?.choices?.[0]?.message?.content || "Er ging iets mis bij het genereren van het antwoord.";

    return res.status(200).json({
      answer,
      sources: national.map(s => ({ title: s.title, link: s.link, type: s.type }))
    });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout bij Beleidsbank" });
  }
}
