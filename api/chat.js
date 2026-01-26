export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { message } = req.body;

  // simpele timeout helper (voorkomt “Bezig met laden…” eindeloos)
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
      .slice(0, 5);

    const term = keywords.length ? keywords.join(" ") : cleaned;

    // 2) SRU query voor OEP (Officiële bekendmakingen)
    // Voorbeeld uit de praktijk gebruikt title=%...% met x-connection=oep :contentReference[oaicite:1]{index=1}
    const like = `%${term}%`; // SRU wildcard-style via %...%
    const sruUrl =
      "https://zoek.officielebekendmakingen.nl/sru/Search" +
      "?version=1.2" +
      "&operation=searchRetrieve" +
      "&x-connection=oep" +
      "&recordSchema=dc" +
      "&maximumRecords=3" +
      "&startRecord=1" +
      "&query=" + encodeURIComponent(`title=${like}`);

    const sruResponse = await fetchWithTimeout(sruUrl, {}, 12000);
    const sruText = await sruResponse.text();

    // 3) Parse DC velden
    const titles = [...sruText.matchAll(/<dc:title>(.*?)<\/dc:title>/g)].map(m => m[1]).slice(0, 3);
    const links  = [...sruText.matchAll(/<dc:identifier>(.*?)<\/dc:identifier>/g)].map(m => m[1]).slice(0, 3);

    // fallback: als title=... niks vindt, probeer keyword all "..."
    if (titles.length === 0 || links.length === 0) {
      const fallbackUrl =
        "https://zoek.officielebekendmakingen.nl/sru/Search" +
        "?version=1.2" +
        "&operation=searchRetrieve" +
        "&x-connection=oep" +
        "&recordSchema=dc" +
        "&maximumRecords=3" +
        "&startRecord=1" +
        "&query=" + encodeURIComponent(`keyword all "${term}"`);

      const fbResp = await fetchWithTimeout(fallbackUrl, {}, 12000);
      const fbText = await fbResp.text();

      const fbTitles = [...fbText.matchAll(/<dc:title>(.*?)<\/dc:title>/g)].map(m => m[1]).slice(0, 3);
      const fbLinks  = [...fbText.matchAll(/<dc:identifier>(.*?)<\/dc:identifier>/g)].map(m => m[1]).slice(0, 3);

      if (fbTitles.length === 0 || fbLinks.length === 0) {
        return res.status(200).json({
          answer:
            "Ik kan dit niet betrouwbaar beantwoorden omdat ik geen officiële bronnen kon ophalen. Probeer een andere term (bijv. ‘passend onderwijs’, ‘zorgplicht’, ‘samenwerkingsverband’).",
          sources: []
        });
      }

      // overschrijf met fallback resultaten
      titles.splice(0, titles.length, ...fbTitles);
      links.splice(0, links.length, ...fbLinks);
    }

    // 4) Maak bronnenblok voor AI
    let sourcesText = "";
    titles.forEach((title, i) => {
      sourcesText += `Bron ${i + 1}: ${title}\n${links[i] || ""}\n\n`;
    });

    // 5) OpenAI (streng, bron-afhankelijk)
    const aiResponse = await fetchWithTimeout(
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

    const aiData = await aiResponse.json();
    const answer =
      aiData?.choices?.[0]?.message?.content ||
      "Er ging iets mis bij het genereren van het antwoord.";

    // 6) Return naar WP
    return res.status(200).json({
      answer,
      sources: titles.map((title, i) => ({
        title,
        link: links[i] || ""
      }))
    });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout bij Beleidsbank" });
  }
}
