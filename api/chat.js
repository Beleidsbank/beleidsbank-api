export default async function handler(req, res) {
  // -----------------------------
  // CORS (voor WordPress)
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { message } = req.body || {};

  // -----------------------------
  // Fetch met timeout (voorkomt "bezig met laden")
  // -----------------------------
  const fetchWithTimeout = async (url, options = {}, ms = 12000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

  // Identifier → echte URL
  const toPublicUrl = (identifier) =>
    identifier ? `https://zoek.officielebekendmakingen.nl/${identifier}.html` : "";

  try {
    // -----------------------------
    // 1. Maak zoekwoorden
    // -----------------------------
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

    // -----------------------------
    // 2. SRU: alleen STAATSCOURANT + STAATSBLAD
    // -----------------------------
    const sruQuery =
      `((publicationname=staatscourant) or (publicationname=staatsblad)) ` +
      `and (keyword all "${term}")`;

    const sruUrl =
      "https://zoek.officielebekendmakingen.nl/sru/Search" +
      "?version=1.2" +
      "&operation=searchRetrieve" +
      "&x-connection=oep" +
      "&recordSchema=dc" +
      "&maximumRecords=25" +
      "&startRecord=1" +
      "&query=" + encodeURIComponent(sruQuery);

    const sruResp = await fetchWithTimeout(sruUrl, {}, 12000);
    const sruText = await sruResp.text();

    // -----------------------------
    // 3. Parse DC / DCTERMS velden
    // -----------------------------
    const pickAll = (re) => [...sruText.matchAll(re)].map(m => m[1]);

    const titles =
      pickAll(/<dcterms:title>(.*?)<\/dcterms:title>/g)
        .concat(pickAll(/<dc:title>(.*?)<\/dc:title>/g))
        .slice(0, 4);

    const ids =
      pickAll(/<dcterms:identifier>(.*?)<\/dcterms:identifier>/g)
        .concat(pickAll(/<dc:identifier>(.*?)<\/dc:identifier>/g))
        .slice(0, 4);

    // -----------------------------
    // 4. Geen landelijke bronnen = STOP
    // -----------------------------
    if (titles.length === 0 || ids.length === 0) {
      return res.status(200).json({
        answer:
          "Ik kon geen landelijke beleidsbronnen (Staatscourant of Staatsblad) vinden voor deze vraag. Beleidsbank v1 toont alleen landelijk beleid. Probeer een expliciete wet- of regelingnaam.",
        sources: []
      });
    }

    // -----------------------------
    // 5. Bouw bronnen
    // -----------------------------
    const sources = titles.map((title, i) => ({
      title,
      link: toPublicUrl(ids[i])
    }));

    const sourcesText = sources
      .map((s, i) => `Bron ${i + 1}: ${s.title}\n${s.link}\n`)
      .join("\n");

    // -----------------------------
    // 6. OpenAI – streng & snel
    // -----------------------------
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
Je bent Beleidsbank.nl.
Je mag ALLEEN antwoorden op basis van de aangeleverde officiële bronnen (Staatscourant/Staatsblad).
Verzin niets en gebruik geen eigen kennis.
Als de bronnen de vraag niet beantwoorden, zeg dat expliciet.

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
    const answer =
      aiData?.choices?.[0]?.message?.content ||
      "Er ging iets mis bij het genereren van het antwoord.";

    // -----------------------------
    // 7. Return naar WordPress
    // -----------------------------
    return res.status(200).json({ answer, sources });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout bij Beleidsbank" });
  }
}
