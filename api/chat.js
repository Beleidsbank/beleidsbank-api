const ALLOW_ORIGIN = "*";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function cleanLegalText(text) {
  return (text || "")
    .replace(/Toon relaties in LiDO/gi, "")
    .replace(/Maak een permanente link/gi, "")
    .replace(/Toon wetstechnische informatie/gi, "")
    .replace(/Druk het regelingonderdeel af/gi, "")
    .replace(/Sla het regelingonderdeel op/gi, "")
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
  const q = text || "";
  return (
    /artikel\s+[0-9a-z:.\-]+/i.test(q) ||
    /\bart\.?\s*[0-9a-z:.\-]+/i.test(q) ||
    /\b[0-9]+(?::|\.)[0-9a-z.-]+\b/i.test(q)
  );
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
    "in twee regels",
    "wat betekent dit",
    "wanneer geldt dit niet",
    "herschrijf",
    "voor een rapport",
    "in bullets",
    "in 3 bullets",
    "kort samen"
  ].some(p => q.includes(p));
}

function extractLastContext(history) {
  const reversed = [...history].reverse();

  for (const msg of reversed) {
    if (
      msg.role === "assistant" &&
      typeof msg.content === "string" &&
      msg.content.includes("Ik heb het relevante artikel gevonden")
    ) {
      const parts = msg.content.split("Bronnen:");
      return (parts[0] || "").trim();
    }
  }

  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
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
      .slice(-16);

    const followUp = isFollowUpQuestion(rawQuestion);
    const lawInQuestion = detectLaw(rawQuestion);
    const lastContext = extractLastContext(safeHistory);

    // 1. Follow-up: gebruik bestaande context, geen nieuwe search
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
          max_tokens: 220,
          messages: [
            {
              role: "system",
              content: `
Je krijgt een artikeltekst.

Regels:
1. Gebruik alleen deze tekst.
2. Voeg geen nieuwe artikelen of nieuwe juridische informatie toe.
3. Verzin niets.
4. Als iets niet in de tekst staat, zeg dat.

Taken:
- samenvatten → kort
- uitleggen → simpel
- praktijk → begrijpelijk uitleggen

Schrijf in het Nederlands.
`.trim()
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

    // 2. Onduidelijke artikelvraag
    if (hasArticleReference(rawQuestion) && !lawInQuestion) {
      return res.status(200).json({
        answer: "Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
        sources: []
      });
    }

    // 3. Normale search
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

    let top = results[0];

    // 4. Exacte artikelmatch op label
    const articleMatch =
      rawQuestion.match(/artikel\s+([0-9a-z:.\-]+)/i) ||
      rawQuestion.match(/\bart\.?\s*([0-9a-z:.\-]+)/i);

    const articleRaw = articleMatch?.[1]?.replace(/\.$/, "");
    const law = detectLaw(rawQuestion);

    if (articleRaw) {
      const normalizedArticle =
        law === "Awb" && /^\d+\.\d+[a-zA-Z]?$/.test(articleRaw)
          ? articleRaw.replace(".", ":")
          : articleRaw;

      const exact = results.find(r => {
        const label = (r.label || "").toLowerCase();
        const lawName = (r.law_name || "").toLowerCase();

        return (
          label.includes(`artikel ${normalizedArticle.toLowerCase()}`) &&
          (!law || lawName === law.toLowerCase())
        );
      });

      if (exact) {
        top = exact;
      } else {
        return res.status(200).json({
          answer: `Ik kan artikel ${normalizedArticle} niet goed vinden. Controleer het artikelnummer.`,
          sources: []
        });
      }
    }

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
      details: String(e?.message || e)
    });
  }
};
