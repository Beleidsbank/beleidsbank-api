// beleidsbank-api/api/chat.js

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

function safeJsonParse(s){
  try { return JSON.parse(s); }
  catch { return null; }
}

function stripModelLeakage(text){
  return (text || "")
    .replace(/you are trained on data up to.*$/gmi,"")
    .replace(/as an ai language model.*$/gmi,"")
    .replace(/als (een )?ai(-| )?taalmodel.*$/gmi,"")
    .trim();
}

function pickHighlight(text){
  if(!text) return "";

  const lines = text
    .split("\n")
    .map(l => l.replace(/\s+/g," ").trim())
    .filter(Boolean);

  const preferred = lines.find(l =>
    l.toLowerCase().includes("wordt verstaan") ||
    l.toLowerCase().includes("schriftelijke beslissing")
  );

  return (preferred || lines[0] || "").slice(0,220);
}

module.exports = async (req,res)=>{

  const origin = (req.headers.origin || "").toString();

  res.setHeader(
    "Access-Control-Allow-Origin",
    origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN
  );

  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");

  if(req.method === "OPTIONS"){
    return res.status(200).end();
  }

  if(req.method !== "POST"){
    return res.status(405).json({error:"Only POST allowed"});
  }

  try{

    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if(!OPENAI_KEY){
      return res.status(500).json({error:"Missing OPENAI_API_KEY"});
    }

    const body =
      typeof req.body === "string"
        ? safeJsonParse(req.body) || {}
        : (req.body || {});

    const question = (body.message || "").toString().trim();

    if(!question){
      return res.status(400).json({error:"Missing message"});
    }

    // -----------------------------------
    // 1 QUERY UNDERSTANDING (AI)
    // -----------------------------------

    const rewriteResp = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          Authorization:`Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model:"gpt-4o-mini",
          temperature:0,
          max_tokens:40,
          messages:[
            {
              role:"systemPrompt",
              content:
              "Herschrijf de vraag naar een korte juridische zoekquery van maximaal 6 woorden."
            },
            {
              role:"user",
              content:question
            }
          ]
        })
      }
    );

    const rewriteText = await rewriteResp.text();
    const rewriteJson = safeJsonParse(rewriteText);

    const searchQuery =
      rewriteJson?.choices?.[0]?.message?.content?.trim()
      || question;

    // -----------------------------------
    // 2 SEARCH IN DATABASE
    // -----------------------------------

    const searchResp = await fetch(
      `https://beleidsbank-api.vercel.app/api/search?q=` +
      encodeURIComponent(searchQuery)
    );

    const searchText = await searchResp.text();
    const searchJson = safeJsonParse(searchText);

    if(!searchResp.ok || !searchJson?.ok){

      return res.status(200).json({
        answer:"Zoeken naar bronnen is mislukt.",
        sources:[]
      });

    }

    const results = (searchJson.results || []).slice(0,30);

    if(!results.length){

      return res.status(200).json({
        answer:"Ik heb nog geen relevante wetgeving in de database gevonden.",
        sources:[]
      });

    }

    // -----------------------------------
    // 3 CONTEXT OPBOUWEN
    // -----------------------------------

    const context = results
      .map((r,i)=>{

        const txt = (r.text || "").trim();

        return `Passage ${i + 1}:\n${txt}`;

      })
      .join("\n\n");

    // -----------------------------------
    // 4 AI ANTWOORD
    // -----------------------------------

    const system = `
Je bent Beleidsbank.

Regels:

1 Gebruik alleen informatie uit de bronpassages.
2 Kies zelf de meest relevante passages.
3 Gebruik alleen passages die direct antwoord geven.
4 Elke zin eindigt met een bronverwijzing zoals [1].
5 Als geen passage het antwoord bevat zeg exact:

"Dit staat niet in de beschikbare wetstekst."
`;

    const aiResp = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          Authorization:`Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model:"gpt-4o-mini",
          temperature:0.1,
          max_tokens:500,
          messages: [
  { role: "system", content: systemPrompt },
            {
              role:"user",
              content:
`Vraag: ${question}

Bronpassages:
${context}`
            }
          ]
        })
      }
    );

    const aiText = await aiResp.text();
    const aiJson = safeJsonParse(aiText);

    if(!aiResp.ok || !aiJson?.choices?.[0]?.message?.content){

      return res.status(200).json({
        answer:"Antwoord genereren is mislukt.",
        sources: results.map((r,i)=>({
          n:i+1,
          id:r.id,
          title:r.label,
          link:r.source_url,
          highlight:pickHighlight(r.text)
        }))
      });

    }

    let answer =
      stripModelLeakage(
        aiJson.choices[0].message.content
      );

    if (!/\d+/.test(answer)) {
      answer = answer + " [1]";
    }

    // -----------------------------------
    // 5 BRONNEN FILTEREN
    // -----------------------------------

    const used = [...answer.matchAll(/\[(\d+)\]/g)]
      .map(m => parseInt(m[1],10));

    const filtered =
      results.filter((r,i)=> used.includes(i+1));

    const sources =
      (filtered.length ? filtered : results)
      .map((r,i)=>({
        n:i+1,
        id:r.id,
        title:r.label,
        link:r.source_url,
        highlight:pickHighlight(r.text)
      }));

    return res.status(200).json({
      answer,
      sources
    });

  }

  catch(e){

    return res.status(500).json({
      error:"chat crashed",
      details:String(e?.message || e)
    });

  }

};
