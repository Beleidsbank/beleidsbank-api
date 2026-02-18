// /pages/api/chat.js
export const config = { api: { bodyParser: true } };

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

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

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const question = (body.message || "").toString().trim();
    if (!question) return res.status(400).json({ error: "Missing message" });

    // 1) haal passages via je eigen search endpoint
    const base =
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://beleidsbank-api.vercel.app";

    const s = await fetch(`${base}/api/search?q=${encodeURIComponent(question)}`);
    const sj = await s.json();

    if (!s.ok || !sj?.ok) {
      return res.status(200).json({
        answer: `Search faalde: ${sj?.error || "unknown error"}`,
        sources: [],
        debug: { search_status: s.status, search: sj },
      });
    }

    const results = (sj.results || []).slice(0, 8);

    if (!results.length) {
      return res.status(200).json({
        answer: "Ik heb nog geen relevante passages in de database gevonden.",
        sources: [],
        debug: { labels: [] },
      });
    }

    // DEBUG: laat zien welke labels chat echt ontvangt
    const debugLabels = results.map(r => r.label);

    // 2) context
    const context = results.map((r, i) => `[${i + 1}] ${r.excerpt}`).join("\n\n");

    const system = `
Je bent Beleidsbank.
Regels:
- Gebruik ALLEEN de meegeleverde bronpassages.
- Citeer met [1], [2], ...
- Als iets niet in de passages staat: zeg dat expliciet.
- Verzin geen artikelen/lidnummers.
- Antwoord kort, zakelijk, zonder marketing.
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
          { role: "user", content: `Vraag:\n${question}\n\nBronpassages:\n${context}` },
        ],
      }),
    });

    const aiJson = await aiResp.json();
    if (!aiResp.ok) {
      return res.status(200).json({
        answer: "OpenAI chat faalde.",
        sources: [],
        debug: { openai: aiJson },
      });
    }

    const answer = (aiJson?.choices?.[0]?.message?.content || "").trim();

    return res.status(200).json({
      answer,
      sources: results.map((r, i) => ({
        n: i + 1,
        title: r.label,
        link: r.source_url,
      })),
      debug: { labels: debugLabels }, // <- tijdelijk
    });
  } catch (e) {
    return res.status(500).json({ error: "chat crashed", details: String(e?.message || e) });
  }
}
