const ALLOW_ORIGIN = "*";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function cleanLegalText(text) {
  return (text || "")
    .replace(/Toon relaties in LiDO/gi, "")
    .replace(/Maak een permanente link/gi, "")
    .replace(/Toon wetstechnische informatie/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detectLaw(text) {
  const q = (text || "").toLowerCase();
  if (q.includes("awb")) return "Awb";
  if (q.includes("omgevingswet")) return "Omgevingswet";
  if (q.includes("bal")) return "Bal";
  if (q.includes("bbl")) return "Bbl";
  if (q.includes("bkl")) return "Bkl";
  if (q.includes("wkb")) return "Wkb";
  return null;
}

function hasArticleReference(text) {
  return /artikel\s+[0-9a-z:.\-]+/i.test(text || "");
}

function isFollowUpQuestion(text) {
  const q = (text || "").toLowerCase();
  return [
    "samenvat",
    "samenvatten",
    "leg uit",
    "in simpele taal",
    "korter",
    "in 2 regels",
    "wat betekent dit",
    "wanneer geldt dit niet",
    "herschrijf",
    "voor een rapport"
  ].some(p => q.includes(p));
}

function extractLastContext(history) {
  const reversed = [...history].reverse();

  for (const msg of reversed) {
    if (msg.role === "assistant" && msg.content.includes("Bronnen:")) {
      const parts = msg.content.split("Bronnen:");
      return parts[0].trim();
    }
  }

  return null;
}

module.exports = async (req, res) => {
  // ✅ CORS FIX
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const body =
      typeof req.body === "string"
        ? safeJsonParse(req.body) || {}
        : (req.body || {});

    const rawQuestion = (body.message || "").toString().trim();
    const history = Array.isArray(body.history) ? body.history : [];

    const safeHistory = history.slice(-10);

    const followUp = isFollowUpQuestion(rawQuestion);
    const lawInQuestion = detectLaw(rawQuestion);
    const lastContext = extractLastContext(safeHistory);

    // ✅ 1. FOLLOW-UP (GEEN SEARCH)
    if (followUp && lastContext) {
      const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.2,
          max_tokens: 200,
          messages: [
            {
              role: "system",
              content: `
Gebruik alleen de gegeven tekst.
Voeg geen nieuwe artikelen toe.
Verzin niets.

Als iets niet in de tekst staat, zeg dat.

Taken:
- samenvatten → kort
- uitleggen → simpel
- praktijk → begrijpelijk
`
            },
            {
              role: "user",
              content: `Vraag: ${rawQuestion}\n\nTekst:\n${lastContext}`
            }
          ]
        })
      });

      const json = await aiResp.json();

      return res.status(200).json({
        answer: json?.choices?.[0]?.message?.content || "",
        sources: []
      });
    }

    // ✅ 2. ONDUIDELIJK ARTIKEL
    if (hasArticleReference(rawQuestion) && !lawInQuestion) {
      return res.status(200).json({
        answer: "Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
        sources: []
      });
    }

    // ✅ 3. SEARCH
    const searchResp = await fetch(
      `https://beleidsbank-api.vercel.app/api/search?q=${encodeURIComponent(rawQuestion)}`
    );

    const searchJson = await searchResp.json();
    const results = searchJson?.results || [];

    if (!results.length) {
      return res.status(200).json({
        answer: "Ik heb geen relevante artikelen gevonden.",
        sources: []
      });
    }

    const top = results[0];

    return res.status(200).json({
      answer: `Ik heb het relevante artikel gevonden.\n\n${cleanLegalText(top.text)}`,
      sources: [
        {
          title: top.label,
          link: top.source_url
        }
      ]
    });

  } catch (e) {
    return res.status(500).json({
      error: "chat crashed",
      details: String(e)
    });
  }
};
