// beleidsbank-api/api/chat.js
// Beleidsbank PRO chat — gebruikt eigen /api/search + OpenAI antwoord
// Response: { answer: string, sources: [{n,id,title,link,highlight}] }

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function stripModelLeakage(text) {
  return (text || "")
    .replace(/you are trained on data up to.*$/gmi, "")
    .replace(/as an ai language model.*$/gmi, "")
    .replace(/als (een )?ai(-| )?taalmodel.*$/gmi, "")
    .trim();
}

function pickHighlight(excerptOrText) {
  const raw = (excerptOrText || "").toString();
  if (!raw.trim()) return "";

  const lines = raw
    .split("\n")
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // voorkeur: definities / kernzinnen
  const preferred = lines.find(l =>
    l.toLowerCase().includes("wordt verstaan") ||
    l.toLowerCase().includes("een schriftelijke beslissing")
  );

  const best =
    preferred ||
    lines.find(l => l.length >= 25 && l.length <= 220) ||
    (lines.join(" ").slice(0, 220));

  return (best || "").slice(0, 220);
}

module.exports = async (req, res) => {
  // CORS
  const origin = (req.headers.origin || "").toString();
  res.setHeader("Access-Control-Allow-Origin", origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  try {
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const body =
      typeof req.body === "string"
        ? safeJsonParse(req.body) || {}
        : (req.body || {});

    const question = (body.message || "").toString().trim();
    if (!question) return res.status(400).json({ error: "Missing message" });

    // 1) Search in eigen DB
    const searchResp = await fetch(
      `https://beleidsbank-api.vercel.app/api/search?q=` + encodeURIComponent(question),
      { method: "GET" }
    );

    const searchText = await searchResp.text();
    const searchJson = safeJsonParse(searchText);

    if (!searchResp.ok || !searchJson?.ok) {
      return res.status(200).json({
        answer: "Zoeken naar bronnen is mislukt.",
        sources: [],
        debug: { status: searchResp.status, preview: searchText.slice(0, 200) }
      });
    }

    const results = (searchJson.results || []).slice(0, 8);
    if (!results.length) {
      return res.status(200).json({
        answer: "Ik heb nog geen relevante wetgeving in de database gevonden.",
        sources: []
      });
    }

    // 2) context voor LLM (ALLEEN passages)
    const context = results
  .map((r, i) => {
    const txt = (r.excerpt || r.text || "").trim();
    return `[${i + 1}] ${txt}`;
  })
  .join("\n\n");

    // 3) OpenAI antwoord
const system = `
Je bent Beleidsbank.

Strikte regels:

1. Gebruik uitsluitend zinnen die letterlijk of direct herleidbaar zijn tot de bronpassages.
2. Elke inhoudelijke zin moet eindigen met een bronverwijzing zoals [1] of [2].
3. Voeg geen uitleg, context, voorbeelden of interpretatie toe.
4. Als de vraag niet direct uit de passages kan worden beantwoord, zeg exact:
   "Dit staat niet in de beschikbare wetstekst."
5. Gebruik geen kennis buiten de meegeleverde passages.
6. Geen afrondende zinnen.

Antwoord compact en juridisch.
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
          { role: "user", content: `Beantwoord de vraag uitsluitend met feiten uit de bronpassages.\nVraag: ${question}\n\nBronpassages:\n${context}` },
        ],
      }),
    });

    const aiText = await aiResp.text();
    const aiJson = safeJsonParse(aiText);

    if (!aiResp.ok || !aiJson?.choices?.[0]?.message?.content) {
      return res.status(200).json({
        answer: "Antwoord genereren is mislukt.",
        sources: results.map((r, i) => ({
          n: i + 1,
          id: r.id,
          title: r.label,
          link: r.source_url,
          highlight: pickHighlight(r.excerpt || r.text || "")
        })),
        debug: { openai_status: aiResp.status, openai_preview: aiText.slice(0, 250) }
      });
    }

    const answer = stripModelLeakage(aiJson.choices[0].message.content || "");

    // HARD LOCK: als geen bronverwijzing aanwezig is → weigeren
if (!/\[\d+\]/.test(answer)) {
  return res.status(200).json({
    answer: "Dit staat niet in de beschikbare wetstekst.",
    sources: results.map((r, i) => ({
      n: i + 1,
      id: r.id,
      title: r.label,
      link: r.source_url,
      highlight: pickHighlight(r.excerpt || r.text || "")
    }))
  });
}

    // 4) Return answer + bronnen (met id + highlight)
    return res.status(200).json({
      answer,
      sources: results.map((r, i) => ({
        n: i + 1,
        id: r.id,
        title: r.label,
        link: r.source_url,
        highlight: pickHighlight(r.excerpt || r.text || "")
      })),
    });

  } catch (e) {
    return res.status(500).json({ error: "chat crashed", details: String(e?.message || e) });
  }
};
