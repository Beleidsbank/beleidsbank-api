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

  try {
    // 1) Maak zoekterm (keywords)
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

    // 2) SRU – Officiële bekendmakingen (OEP)
    // Voorbeeld: SRU met x-connection=oep werkt op zoek.officielebekendmakingen.nl :contentReference[oaicite:1]{index=1}
    const sruUrl =
      "https://zoek.officielebekendmakingen.nl/sru/Search" +
      "?version=1.2" +
      "&operation=searchRetrieve" +
      "&x-connection=oep" +
      "&recordSchema=dc" +
      "&maximumRecords=5" +
      "&startRecord=1" +
      "&query=" + encodeURIComponent(`keyword all "${term}"`);

    const sruResp = await fetchWithTimeout(sruUrl, {}, 12000);
    const sruText = await sruResp.text();

    // 3) Parse titels/links uit zowel dc:* als dcterms:* (komt per collectie/recordschema voor)
    const pick = (re) => [...sruText.matchAll(re)].map(m => m[1]);

    const titles =
      pick(/<dcterms:title>(.*?)<\/dcterms:title>/g)
        .concat(pick(/<dc:title>(.*?)<\/dc:title>/g))
        .slice(0, 5);

    const links =
      pick(/<dcterms:identifier>(.*?)<\/dcterms:identifier>/g)
        .concat(pick(/<dc:identifier>(.*?)<\/dc:identifier>/g))
        .slice(0, 5);

    // Debug: laat zien wat SRU terugstuurt (eerste stuk) + de URL die je gebruikt
    if (debug) {
      return res.status(200).json({
        sruUrl,
        httpStatus: sruResp.status,
        foundTitles: titles.length,
        foundLinks: links.length,
        sample: sruText.slice(0, 1200) // eerste 1200 tekens
      });
    }

    if (!titles.length || !links.length) {
      return res.status(200).json({
        answer:
          "Ik kan dit niet betrouwbaar beantwoorden omdat ik geen officiële bronnen kon uitlezen uit de zoekresultaten. (Technisch: SRU gaf wel antwoord, maar ik vond geen titel/links in het record.)",
        sources: []
      });
    }

    // 4) Bronnenblok voor AI
    const sources = titles.map((title, i) => ({
      title,
      link: links[i] || ""
    })).filter(s => s.title && s.link);

    const sourcesText = sources
      .slice(0, 4)
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}\n`)
      .join("\n");

    // 5) OpenAI – strikt bronnen-only
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
          max_tokens: 450,
          messages: [
            {
              role: "system",
              content: `
Je bent Beleidsbank.nl.
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen.
Verzin niets en gebruik geen eigen kennis.
Als de bronnen onvoldoende zijn: zeg dat expliciet.

Structuur:
1) Kort antwoord
2) Toelichting (alleen uit bronnen)
3) Bronnen (genummerd)
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
    const answer = aiData?.choices?.[0]?.message?.content
      || "Er ging iets mis bij het genereren van het antwoord.";

    return res.status(200).json({ answer, sources: sources.slice(0, 4) });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout bij Beleidsbank" });
  }
}
