// /pages/api/chat.js
// Beleidsbank PRO chat — direct Supabase search call (GEEN interne fetch meer)

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {

    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    const question = (body.message || "").toString().trim();

    if (!question) {
      return res.status(400).json({ error: "Missing message" });
    }

    // ---------------------------
    // 1. EMBEDDING VAN DE VRAAG
    // ---------------------------
    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: question
      })
    });

    const embJson = await embResp.json();
    const embedding = embJson.data[0].embedding;

    // ---------------------------
    // 2. SUPABASE VECTOR SEARCH
    // ---------------------------
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data } = await supabase.rpc("match_chunks", {
      query_embedding: embedding,
      match_threshold: 0.2,
      match_count: 5
    });

    const results = data || [];

    if (!results.length) {
      return res.json({
        answer:
          "Ik kon geen relevante passages vinden in de officiële databronnen.",
        sources: []
      });
    }

    // ---------------------------
    // 3. CONTEXT MAKEN
    // ---------------------------
    const context = results
      .map((r,i)=>`[${i+1}] ${r.text}`)
      .join("\n\n");

    // ---------------------------
    // 4. OPENAI ANTWOORD
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
- Citeer bronnen met [1], [2].
- Verzin niets.
- Antwoord zakelijk Nederlands.
`
          },
          {
            role:"user",
            content:`
Vraag:

${question}

Bronpassages:

${context}

Geef antwoord met bronverwijzingen.
`
          }
        ]
      })
    });

    const aiJson = await ai.json();
    const answer = aiJson?.choices?.[0]?.message?.content || "";

    // ---------------------------
    // 5. RETURN
    // ---------------------------
    return res.json({
      answer,
      sources: results.map((r,i)=>({
        n:i+1,
        title: r.doc_id || "Wetgeving",
        link: r.source_url || ""
      }))
    });

  } catch(e) {

    return res.status(500).json({
      crash:String(e)
    });

  }
}
