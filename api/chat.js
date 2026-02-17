// /api/chat.js
// Beleidsbank PRO chat — gebruikt eigen Supabase search

module.exports = async (req, res) => {
  try {

    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    const question = (body.message || "").toString().trim();

    if (!question) {
      return res.status(400).json({ error: "Missing message" });
    }

    // ---------------------------
    // 1. Zoek passages uit eigen DB
    // ---------------------------
    const base = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://beleidsbank-api.vercel.app";

const searchResp = await fetch(
  `${base}/api/search?q=` + encodeURIComponent(question)
);


    const searchJson = await searchResp.json();

    const results = (searchJson.results || []).slice(0,5);

    if (!results.length) {
      return res.json({
        answer:
          "Ik kon geen relevante passages vinden in de officiële databronnen.",
        sources: []
      });
    }

    // ---------------------------
    // 2. Maak context voor AI
    // ---------------------------
    const context = results
      .map((r,i)=>`[${i+1}] ${r.excerpt}`)
      .join("\n\n");

    // ---------------------------
    // 3. Vraag OpenAI antwoord
    // ---------------------------
    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:`Bearer ${OPENAI_KEY}`
      },
      body:JSON.stringify({
        model:"gpt-4o-mini",
        temperature:0.1,
        max_tokens:600,
        messages:[
          {
            role:"system",
            content:`
Je bent Beleidsbank.

Regels:
- Gebruik ALLEEN de gegeven bronpassages.
- Als info ontbreekt → zeg dat expliciet.
- Citeer bronnen met [1], [2], ...
- Verzin niets.
- Geen artikelnummers verzinnen.
- Antwoord in helder Nederlands.
`
          },
          {
            role:"user",
            content:`
Vraag:

${question}

Bronpassages:

${context}

Geef een concreet antwoord met bronverwijzingen.
`
          }
        ]
      })
    });

    const aiJson = await ai.json();
    const answer = aiJson?.choices?.[0]?.message?.content || "";

    // ---------------------------
    // 4. Return antwoord + bronnen
    // ---------------------------
    return res.json({
      answer,
      sources: results.map((r,i)=>({
        n:i+1,
        title: r.label || r.doc_id,
        link: r.source_url
      }))
    });

  } catch(e) {
    return res.status(500).json({
      crash:String(e)
    });
  }
};
