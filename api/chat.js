export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message } = req.body;

  try {
    // 1. SRU zoekopdracht
    const sruUrl =
      "https://zoekservice.overheid.nl/sru/Search" +
      "?version=1.2" +
      "&operation=searchRetrieve" +
      "&maximumRecords=3" +
      "&query=" +
      encodeURIComponent(message);

    const sruResponse = await fetch(sruUrl);
    const sruText = await sruResponse.text();

    // 2. Simpel titels + links uit XML halen
    const titles = [...sruText.matchAll(/<dc:title>(.*?)<\/dc:title>/g)]
      .map(m => m[1])
      .slice(0, 3);

    const links = [...sruText.matchAll(/<dc:identifier>(.*?)<\/dc:identifier>/g)]
      .map(m => m[1])
      .slice(0, 3);

    let sourcesText = "";
    titles.forEach((title, i) => {
      sourcesText += `Bron ${i + 1}: ${title}\n${links[i] || ""}\n\n`;
    });

    // 3. AI antwoord laten maken op basis van bronnen
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
  {
    role: "system",
    content: `
Je bent Beleidsbank.nl.
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen.
Verzin geen informatie en gebruik geen eigen kennis.
Als de bronnen onvoldoende zijn om de vraag te beantwoorden, zeg dat expliciet.

Je antwoord MOET exact deze structuur volgen:

1. Kort antwoord (max 4 zinnen)
2. Toelichting (alleen wat letterlijk uit de bronnen volgt)
3. Bronnen (genummerde lijst, exact zoals aangeleverd)

Gebruik helder, neutraal Nederlands.
`
  },
  {
    role: "user",
    content: `
Vraag:
${message}

Officiële bronnen:
${sourcesText}
`
  }
]

      })
    });

    const aiData = await aiResponse.json();
    const answer = aiData.choices[0].message.content;

    res.status(200).json({
      answer,
      sources: titles.map((title, i) => ({
        title,
        link: links[i] || ""
      }))
    });

  } catch (error) {
    res.status(500).json({ error: "Fout bij ophalen beleid" });
  }
}
