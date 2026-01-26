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
    // -------------------------------
    // 1. Zoek officiële publicaties (SRU)
    // -------------------------------
   // Maak van de vraag een simpele zoekquery (keywords)
const cleaned = (message || "")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, " ") // verwijder leestekens
  .replace(/\s+/g, " ")
  .trim();

// haal wat stopwoorden weg (simpel, maar effectief)
const stop = new Set(["wat","wanneer","is","de","het","een","rond","over","in","op","van","en","voor","ik","kan","kun","je","jij","beleid","wet"]);
const keywords = cleaned
  .split(" ")
  .filter(w => w.length >= 3 && !stop.has(w))
  .slice(0, 6); // max 6 woorden

// als er niks overblijft, gebruik toch de originele tekst
const searchTerms = keywords.length ? keywords.join(" ") : cleaned;

// SRU CQL query
const cql = `cql.anywhere all "${searchTerms}"`;

const sruUrl =
  "https://zoekservice.overheid.nl/sru/Search" +
  "?version=1.2" +
  "&operation=searchRetrieve" +
  "&recordSchema=dc" +
  "&maximumRecords=3" +
  "&query=" +
  encodeURIComponent(cql);


    const sruResponse = await fetch(sruUrl);
    const sruText = await sruResponse.text();

    // -------------------------------
    // 2. Haal TITELS en LINKS uit XML
    // -------------------------------
    const titles = [...sruText.matchAll(/<dc:title>(.*?)<\/dc:title>/g)]
      .map(m => m[1])
      .slice(0, 3);

    const links = [...sruText.matchAll(/<dc:identifier>(.*?)<\/dc:identifier>/g)]
      .map(m => m[1])
      .slice(0, 3);

    // -------------------------------
    // 3. STOP als er geen bronnen zijn
    // -------------------------------
    if (titles.length === 0 || links.length === 0) {
      return res.status(200).json({
        answer:
          "Ik kan deze vraag niet betrouwbaar beantwoorden omdat er geen officiële bronnen zijn gevonden. Probeer een concretere beleidsvraag.",
        sources: []
      });
    }

    // -------------------------------
    // 4. Bouw bron-tekst voor AI
    // -------------------------------
    let sourcesText = "";
    titles.forEach((title, i) => {
      sourcesText += `Bron ${i + 1}: ${title}\n${links[i]}\n\n`;
    });

    // -------------------------------
    // 5. AI antwoord (streng)
    // -------------------------------
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content: `
Je bent Beleidsbank.nl.
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen.
Verzin geen informatie.
Als de bronnen onvoldoende zijn, zeg dat expliciet.

Je antwoord MOET exact deze structuur volgen:
1. Kort antwoord
2. Toelichting (alleen uit bronnen)
3. Bronnen (genummerd)
`
          },
          {
            role: "user",
            content: `Vraag:\n${message}\n\nOfficiële bronnen:\n${sourcesText}`
          }
        ]
      })
    });

    const aiData = await aiResponse.json();
    const answer = aiData.choices[0].message.content;

    // -------------------------------
    // 6. Terug naar WordPress
    // -------------------------------
    res.status(200).json({
      answer,
      sources: titles.map((title, i) => ({
        title,
        link: links[i]
      }))
    });

  } catch (error) {
    res.status(500).json({
      error: "Interne fout bij beleidsbank"
    });
  }
}
