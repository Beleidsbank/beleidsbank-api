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

function cleanLegalText(text) {
  return (text || "")
    .replace(/Toon relaties in LiDO/gi, "")
    .replace(/Maak een permanente link/gi, "")
    .replace(/Toon wetstechnische informatie/gi, "")
    .replace(/Druk het regelingonderdeel af/gi, "")
    .replace(/Sla het regelingonderdeel op/gi, "")
    .replace(/Geen andere versie om mee te vergelijken/gi, "")
    .replace(/^\s*\.\.\.\s*$/gmi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n([a-z])\.\n/g, "\n$1. ")
    .replace(/\n([0-9]+°?)\.\n/g, "\n$1. ")
    .trim();
}

function pickHighlight(text) {
  const raw = cleanLegalText(text || "");
  if (!raw) return "";

  const lines = raw
    .split("\n")
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const preferred = lines.find(l =>
    l.toLowerCase().includes("wordt verstaan") ||
    l.toLowerCase().includes("schriftelijke beslissing")
  );

  return (preferred || lines[0] || raw).slice(0, 220);
}

module.exports = async (req, res) => {
  const origin = (req.headers.origin || "").toString();

  res.setHeader(
    "Access-Control-Allow-Origin",
    origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN
  );
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const body =
      typeof req.body === "string"
        ? safeJsonParse(req.body) || {}
        : (req.body || {});

    const rawQuestion = (body.message || "").toString().trim();
    const history = Array.isArray(body.history) ? body.history : [];

    if (!rawQuestion) {
      return res.status(400).json({ error: "Missing message" });
    }

    // Alleen veilige history doorlaten
    const safeHistory = history
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-12)
      .map(m => ({
        role: m.role,
        content: String(m.content).slice(0, 1200)
      }));

    // 1) AI maakt context-aware zoekquery
    const rewriteSystem = `
Je zet een gebruikersvraag plus korte chatgeschiedenis om naar één korte juridische zoekquery.
Regels:
1. Geef alleen de zoekquery terug, geen uitleg.
2. Als de gebruiker alleen een wetnaam antwoordt op een eerdere artikelvraag, combineer die context.
3. Voorbeelden:
- "Artikel 3:40" + "Awb" -> "artikel 3:40 awb"
- "Wat is een besluit?" -> "besluit"
- "Wanneer treedt een besluit in werking?" -> "besluit in werking bekendgemaakt"
`.trim();

    const rewriteMessages = [
      { role: "system", content: rewriteSystem },
      ...safeHistory,
      { role: "user", content: rawQuestion }
    ];

    const rewriteResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 40,
        messages: rewriteMessages
      })
    });

    const rewriteText = await rewriteResp.text();
    const rewriteJson = safeJsonParse(rewriteText);
    const searchQuery =
      rewriteJson?.choices?.[0]?.message?.content?.trim() || rawQuestion;

    // 2) Search
    const searchResp = await fetch(
      `https://beleidsbank-api.vercel.app/api/search?q=` + encodeURIComponent(searchQuery),
      { method: "GET" }
    );

    const searchText = await searchResp.text();
    const searchJson = safeJsonParse(searchText);

    if (!searchResp.ok || !searchJson?.ok) {
      return res.status(200).json({
        answer: "Zoeken naar bronnen is mislukt.",
        sources: []
      });
    }

    // 3) Ambigue artikelvraag -> doorvragen
    if (searchJson?.ambiguous && searchJson?.question) {
      return res.status(200).json({
        answer: searchJson.question,
        sources: []
      });
    }

    const results = (searchJson.results || []).slice(0, 12);

    if (!results.length) {
      return res.status(200).json({
        answer: "Ik heb nog geen relevante wetgeving in de database gevonden.",
        sources: []
      });
    }

    // 4) Artikelvraag: direct artikel tonen, geen AI samenvatting
    if (/artikel\s+[0-9]/i.test(searchQuery)) {
      const r = results[0];
      const cleaned = cleanLegalText(r.text || "");

      return res.status(200).json({
        answer: cleaned,
        sources: [{
          n: 1,
          id: r.id,
          title: r.label,
          link: r.source_url,
          highlight: pickHighlight(cleaned)
        }]
      });
    }

    // 5) Context opbouwen
    const context = results
      .map((r, i) => {
        const txt = cleanLegalText((r.excerpt || r.text || "").slice(0, 700));
        return `[${i + 1}] ${txt}`;
      })
      .join("\n\n");

    const answerSystem = `
Je bent Beleidsbank.

Regels:
1. Gebruik alleen informatie uit de bronpassages.
2. Gebruik alleen passages die direct relevant zijn voor de vraag.
3. Elke inhoudelijke zin eindigt met een bronverwijzing zoals [1].
4. Als het antwoord niet direct uit de passages volgt, zeg exact:
"Dit staat niet in de beschikbare wetstekst."
5. Voeg geen eigen interpretatie toe.
6. Antwoord compact en juridisch.
`.trim();

    // 6) AI antwoord
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 450,
        messages: [
          { role: "system", content: answerSystem },
          {
            role: "user",
            content: `Vraag: ${rawQuestion}\n\nZoekquery: ${searchQuery}\n\nBronpassages:\n${context}`
          }
        ]
      })
    });

    const aiText = await aiResp.text();
    const aiJson = safeJsonParse(aiText);

    // 7) Fallback als OpenAI faalt
    if (!aiResp.ok || !aiJson?.choices?.[0]?.message?.content) {
      const fallback = pickHighlight(results[0].excerpt || results[0].text || "");
      return res.status(200).json({
        answer: fallback ? `${fallback} [1]` : "Dit staat niet in de beschikbare wetstekst.",
        sources: [{
          n: 1,
          id: results[0].id,
          title: results[0].label,
          link: results[0].source_url,
          highlight: pickHighlight(results[0].excerpt || results[0].text || "")
        }]
      });
    }

    let answer = stripModelLeakage(aiJson.choices[0].message.content || "");

    if (!/\[\d+\]/.test(answer)) {
      answer = answer + " [1]";
    }

    // 8) Alleen gebruikte bronnen tonen
    const used = [...answer.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1], 10));
    const filtered = results.filter((r, i) => used.includes(i + 1));

    return res.status(200).json({
      answer,
      sources: (filtered.length ? filtered : results.slice(0, 3)).map((r, i) => ({
        n: i + 1,
        id: r.id,
        title: r.label,
        link: r.source_url,
        highlight: pickHighlight(r.excerpt || r.text || "")
      }))
    });

  } catch (e) {
    return res.status(500).json({
      error: "chat crashed",
      details: String(e?.message || e)
    });
  }
};
