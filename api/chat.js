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

  return (preferred || lines[0] || raw).slice(0, 240);
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

    const safeHistory = history
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-12)
      .map(m => ({
        role: m.role,
        content: String(m.content).slice(0, 1200)
      }));

    const rewriteSystem = `
Je zet een gebruikersvraag plus korte chatgeschiedenis om naar één korte juridische zoekquery.

Regels:
1. Geef alleen de zoekquery terug, geen uitleg.
2. Als de gebruiker alleen een wetnaam antwoordt op een eerdere vraag, combineer die context.
3. Houd de zoekquery kort en bruikbaar voor wetgeving.
4. Voorbeelden:
- "Artikel 3:40" + "Awb" -> "artikel 3:40 awb"
- "Wat is een besluit?" + "Awb" -> "besluit awb"
- "Wanneer is bezwaar mogelijk?" -> "bezwaar awb"
- "Artikel 5.1" + "Omgevingswet" -> "artikel 5.1 omgevingswet"
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


    // --------------------------------
// EXTRA: slimme intent detectie
// --------------------------------

const lowerQ = rawQuestion.toLowerCase();

// 1. Als vraag onduidelijk is (artikel zonder wet)
if (
  lowerQ.includes("artikel") &&
  !lowerQ.includes("awb") &&
  !lowerQ.includes("omgevingswet") &&
  !lowerQ.includes("bal") &&
  !lowerQ.includes("bbl") &&
  !lowerQ.includes("bkl") &&
  !lowerQ.includes("wkb")
) {
  return res.status(200).json({
    answer: "Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
    sources: []
  });
}

// 2. Follow-up detectie (samenvatten / uitleggen)
const isFollowUp =
  lowerQ.includes("samenvat") ||
  lowerQ.includes("kort") ||
  lowerQ.includes("leg uit") ||
  lowerQ.includes("in simpele taal") ||
  lowerQ.includes("in 2 regels");

// als follow-up → GEEN nieuwe search doen
if (isFollowUp && safeHistory.length > 0) {
  const lastAnswer = safeHistory
    .filter(m => m.role === "assistant")
    .slice(-1)[0]?.content;

  if (lastAnswer) {
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: "Herschrijf of vat de tekst samen volgens de vraag van de gebruiker. Voeg geen nieuwe informatie toe."
          },
          {
            role: "user",
            content: `Vraag: ${rawQuestion}\n\nTekst:\n${lastAnswer}`
          }
        ]
      })
    });

    const aiJson = await aiResp.json();

    return res.status(200).json({
      answer: aiJson?.choices?.[0]?.message?.content || "",
      sources: []
    });
  }
}

    
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

    const results = (searchJson.results || []).slice(0, 2);

    if (!results.length) {
      return res.status(200).json({
        answer: "Ik heb geen relevante artikelen gevonden in de huidige wetgeving.",
        sources: []
      });
    }

    if (/artikel\s+[0-9]/i.test(searchQuery)) {
      const r = results[0];
      const cleaned = cleanLegalText(r.text || "");

      return res.status(200).json({
        answer: `Ik heb het relevante artikel gevonden.\n\n${cleaned}`,
        sources: [{
          n: 1,
          id: r.id,
          title: r.label,
          link: r.source_url,
          highlight: pickHighlight(cleaned)
        }]
      });
    }

    const context = results
      .map((r, i) => {
        const txt = cleanLegalText((r.excerpt || r.text || "").slice(0, 900));
        return `[${i + 1}] ${r.label}\n${txt}`;
      })
      .join("\n\n");

    const answerSystem = `
Je bent Beleidsbank, een juridische AI-assistent voor Nederlandse wetgeving.

Doel:
Geef een correct en betrouwbaar antwoord op basis van de bronpassages.

BELANGRIJK:
1. Gebruik alleen informatie die letterlijk of direct logisch uit de bronpassages volgt.
2. Gebruik MAXIMAAL 2 artikelen.
3. Gebruik alleen de meest relevante artikelen.
4. Voeg GEEN extra artikelen toe voor context.
5. Als een artikel niet direct nodig is: niet noemen.
6. Als je twijfelt: niet noemen.
7. Gebruik zo veel mogelijk formuleringen die dicht bij de wetstekst blijven.

ANTWOORDSTRUCTUUR:
- Begin met een kort en duidelijk antwoord.
- Geef daarna 1 korte toelichting.
- Houd het compact en natuurlijk.

BRONNEN:
- Gebruik bronverwijzingen zoals [1] en [2].
- Gebruik alleen bronnen die echt nodig zijn.

FALLBACK:
Als het antwoord niet direct uit de passages volgt, zeg exact:
"Ik kan dit niet goed beantwoorden op basis van de gevonden artikelen."

VERBODEN:
- Artikelen verzinnen.
- Artikelen combineren die niet direct nodig zijn.
- Uitleg geven die niet uit de tekst volgt.

Schrijf in het Nederlands.
`.trim();

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 400,
        messages: [
          { role: "system", content: answerSystem },
          {
            role: "user",
            content: `Vraag: ${rawQuestion}

Zoekquery: ${searchQuery}

Bronpassages:
${context}`
          }
        ]
      })
    });

    const aiText = await aiResp.text();
    const aiJson = safeJsonParse(aiText);

    if (!aiResp.ok || !aiJson?.choices?.[0]?.message?.content) {
      const fallback = pickHighlight(results[0].excerpt || results[0].text || "");
      return res.status(200).json({
        answer: fallback || "Ik kan dit niet goed beantwoorden op basis van de gevonden artikelen.",
        sources: [{
          n: 1,
          id: results[0].id,
          title: results[0].label,
          link: results[0].source_url,
          highlight: pickHighlight(results[0].excerpt || results[0].text || "")
        }]
      });
    }

    let answer = stripModelLeakage(aiJson.choices[0].message.content || "").trim();

    if (!answer) {
      answer = "Ik kan dit niet goed beantwoorden op basis van de gevonden artikelen.";
    }

    const used = [...answer.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1], 10));
    const filtered = results.filter((r, i) => used.includes(i + 1));

    return res.status(200).json({
      answer,
      sources: (filtered.length ? filtered : results.slice(0, 2)).map((r, i) => ({
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
