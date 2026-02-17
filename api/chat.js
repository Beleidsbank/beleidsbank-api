// /pages/api/chat.js
// Beleidsbank PRO (V1) — Chat op basis van eigen Supabase-index (geen SRU, geen scraping)
// Response: { answer: string, sources: [{n,title,link}] }

export const config = { api: { bodyParser: true } };

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toVector(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}

export default async function handler(req, res) {
  // CORS
  const origin = (req.headers.origin || "").toString();
  res.setHeader("Access-Control-Allow-Origin", origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
    if (!OPENAI_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const question = (body.message || "").toString().trim();
    if (!question) return res.status(400).json({ error: "Missing message" });

    // 1) Embedding van de vraag
    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: question,
      }),
    });
    const embJson = await embResp.json();
    if (!embResp.ok) return res.status(500).json({ error: "OpenAI embeddings failed", details: embJson });

    const qvec = toVector(embJson?.data?.[0]?.embedding);
    if (!qvec) return res.status(500).json({ error: "Invalid embedding from OpenAI" });

    // 2) Haal chunks op uit Supabase (V1: simpel, later optimaliseren)
    // Tip: als je later veel data hebt, bouwen we echte DB-side vector search.
    const chunksResp = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id,doc_id,label,text,source_url,embedding&limit=500`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      }
    );

    const chunks = await chunksResp.json();
    if (!chunksResp.ok) {
      return res.status(500).json({ error: "Supabase chunks fetch failed", details: chunks });
    }
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(200).json({
        answer: "Ik heb nog geen wetgeving in de database staan om op te zoeken.",
        sources: [],
      });
    }

    // 3) Rank op cosine similarity
    const ranked = chunks
      .map((c) => {
        const emb = toVector(c.embedding);
        if (!emb) return null;
        return { ...c, _sim: cosine(qvec, emb) };
      })
      .filter(Boolean)
      .sort((a, b) => b._sim - a._sim)
      .slice(0, 5);

    if (ranked.length === 0) {
      return res.status(200).json({
        answer: "Ik kon geen relevante passages vinden in de officiële databronnen.",
        sources: [],
      });
    }

    // 4) Context voor AI
    const context = ranked
      .map((r, i) => `[${i + 1}] ${r.text}`)
      .join("\n\n");

    const system = `
Je bent Beleidsbank.
Beantwoord kort en zakelijk in het Nederlands.

Harde regels:
- Gebruik ALLEEN de meegeleverde bronpassages.
- Citeer met [1], [2], ...
- Als iets niet in de passages staat: zeg dat expliciet.
- Verzin geen artikel-/lidnummers.
`.trim();

    // 5) Chat completion
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 650,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Vraag:\n${question}\n\nBronpassages:\n${context}\n\nGeef antwoord met bronverwijzingen.`,
          },
        ],
      }),
    });

    const aiJson = await aiResp.json();
    if (!aiResp.ok) return res.status(500).json({ error: "OpenAI chat failed", details: aiJson });

    const answer = (aiJson?.choices?.[0]?.message?.content || "").trim();

    return res.status(200).json({
      answer,
      sources: ranked.map((r, i) => ({
        n: i + 1,
        title: r.label || r.doc_id || "Wetgeving",
        link: r.source_url || "",
      })),
    });
  } catch (e) {
    return res.status(500).json({ crash: String(e?.message || e) });
  }
}
