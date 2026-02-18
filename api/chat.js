// /pages/api/chat.js
export const config = { api: { bodyParser: true } };

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

// Zet dit later in Vercel env als BELEIDSBANK_API_BASE
// Voor nu hard, zodat het altijd goed is.
const DEFAULT_SEARCH_BASE = "https://beleidsbank-api.vercel.app";

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
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
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const body = typeof req.body === "string" ? safeJsonParse(req.body) || {} : (req.body || {});
    const question = (body.message || "").toString().trim();
    if (!question) return res.status(400).json({ error: "Missing message" });

    // ✅ BELANGRIJK: altijd naar de backend waar /api/search bestaat
    const SEARCH_BASE = (process.env.BELEIDSBANK_API_BASE || DEFAULT_SEARCH_BASE).replace(/\/+$/, "");
    const searchUrl = `${SEARCH_BASE}/api/search?q=${encodeURIComponent(question)}`;

    const sResp = await fetch(searchUrl);
    const sText = await sResp.text();
    const sJson = safeJsonParse(sText);

    // Als search HTML teruggeeft of iets anders: netjes melden (geen crash)
    if (!sJson || !sJson.ok) {
      return res.status(200).json({
        answer: "Search faalde (geen geldige JSON response).",
        sources: [],
        debug: {
          searchUrl,
          status: sResp.status,
          contentType: sResp.headers.get("content-type"),
          preview: sText.slice(0, 200)
        }
      });
    }

    const results = (sJson.results || []).slice(0, 8);
    if (!results.length) {
      return res.status(200).json({
        answer: "Ik kon geen relevante passages vinden in de officiële databronnen.",
        sources: [],
        debug: { searchUrl }
      });
    }

    const context = results.map((r, i) => `[${i + 1}] ${r.excerpt}`).join("\n\n");

    const system = `
Je bent Beleidsbank.
Regels:
- Gebruik ALLEEN de meegeleverde bronpassages.
- Citeer met [1], [2], ...
- Als iets niet in de passages staat: zeg dat expliciet.
- Verzin geen artikelen/lidnummers.
- Antwoord kort en zakelijk.
`.trim();

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
          { role: "user", content: `Vraag:\n${question}\n\nBronpassages:\n${context}` }
        ],
      }),
    });

    const aiText = await aiResp.text();
    const aiJson = safeJsonParse(aiText);

    if (!aiResp.ok || !aiJson?.choices?.[0]?.message?.content) {
      return res.status(200).json({
        answer: "OpenAI chat faalde.",
        sources: results.map((r, i) => ({ n: i + 1, title: r.label, link: r.source_url })),
        debug: { openai_status: aiResp.status, openai_preview: aiText.slice(0, 300) }
      });
    }

    const answer = (aiJson.choices[0].message.content || "").trim();

    return res.status(200).json({
      answer,
      sources: results.map((r, i) => ({
        n: i + 1,
        title: r.label,
        link: r.source_url
      })),
      debug: {
        searchUrl,
        labels: results.map(r => r.label)
      }
    });

  } catch (e) {
    return res.status(500).json({ error: "chat crashed", details: String(e?.message || e) });
  }
}
