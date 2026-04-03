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
  const q = (text || "").toLowerCase().trim();
  if (q.includes("awb")) return "Awb";
  if (q.includes("omgevingswet")) return "Omgevingswet";
  if (q.includes("bal")) return "Bal";
  if (q.includes("bbl")) return "Bbl";
  if (q.includes("bkl")) return "Bkl";
  if (q.includes("wkb")) return "Wkb";
  return null;
}

function isLawOnlyMessage(text) {
  const q = (text || "").toLowerCase().trim();
  return ["awb", "omgevingswet", "bal", "bbl", "bkl", "wkb"].includes(q);
}

function extractArticleRef(text) {
  const q = (text || "").trim();
  const m =
    q.match(/artikel\s+([0-9a-zA-Z:.\-]+)/i) ||
    q.match(/\bart\.?\s*([0-9a-zA-Z:.\-]+)/i) ||
    q.match(/\b([0-9]+(?::|\.)[0-9a-zA-Z.\-]+)\b/i);

  if (!m?.[1]) return null;
  return m[1].replace(/\.$/, "");
}

function normalizeArticle(article, lawName) {
  if (!article) return null;
  let a = article.trim();

  if (lawName === "Awb" && /^\d+\.\d+[a-zA-Z]?$/.test(a)) {
    a = a.replace(".", ":");
  }

  return a;
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
    "kort samen",
    "leg dit uit",
    "leg dit simpeler uit",
    "geef voorbeeld",
    "geef een voorbeeld",
    "maak samenvatting"
  ].some(p => q.includes(p));
}

function extractLastArticleContext(history) {
  const reversed = [...history].reverse();

  for (const msg of reversed) {
    if (
      msg &&
      msg.role === "assistant" &&
      typeof msg.content === "string" &&
      msg.content.includes("Ik heb het relevante artikel gevonden")
    ) {
      const main = msg.content.split("Bronnen:")[0]?.trim() || "";
      if (main) return main;
    }
  }

  return null;
}

function extractLastUserArticle(history) {
  const reversed = [...history].reverse();

  for (const msg of reversed) {
    if (msg?.role === "user" && typeof msg.content === "string") {
      const art = extractArticleRef(msg.content);
      if (art) return art;
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
      .slice(-20);

    const followUp = isFollowUpQuestion(rawQuestion);
    const lastArticleContext = extractLastArticleContext(safeHistory);

    // 1) Follow-up op eerder artikel: geen nieuwe search
    if (followUp && lastArticleContext) {
      const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.2,
          max_tokens: 260,
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
- voorbeeld → alleen een eenvoudig voorbeeld geven als dat logisch direct uit de tekst volgt

Schrijf in het Nederlands.
`.trim()
            },
            {
              role: "user",
              content: `Vraag: ${rawQuestion}

Tekst:
${lastArticleContext}`
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

    // 2) Context-aware zoekquery bouwen
    const currentLaw = detectLaw(rawQuestion);
    const currentArticle = extractArticleRef(rawQuestion);

    let searchQuery = rawQuestion;

    // Artikel zonder wet -> doorvragen
    if (currentArticle && !currentLaw) {
      return res.status(200).json({
        answer: "Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
        sources: []
      });
    }

    // Alleen wetnaam als antwoord op eerdere artikelvraag
    if (isLawOnlyMessage(rawQuestion)) {
      const previousArticle = extractLastUserArticle(safeHistory);

      if (previousArticle) {
        const normalized = normalizeArticle(previousArticle, currentLaw);
        searchQuery = `artikel ${normalized} ${currentLaw}`;
      } else {
        return res.status(200).json({
          answer: "Op welk artikel doel je precies?",
          sources: []
        });
      }
    }

    // Normale artikelvraag met wet
    if (currentArticle && currentLaw) {
      const normalized = normalizeArticle(currentArticle, currentLaw);
      searchQuery = `artikel ${normalized} ${currentLaw}`;
    }

    // 3) Search
    const searchResp = await fetch(
      `https://beleidsbank-api.vercel.app/api/search?q=${encodeURIComponent(searchQuery)}`
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

    // 4) Bij artikelvraag: exacte match kiezen
    const searchLaw = detectLaw(searchQuery);
    const searchArticleRaw = extractArticleRef(searchQuery);
    const searchArticle = normalizeArticle(searchArticleRaw, searchLaw);

    if (searchArticle) {
      const exact = results.find(r => {
        const label = (r.label || "").toLowerCase();
        const lawName = (r.law_name || "").toLowerCase();
        const articleNumber = (r.article_number || "").toLowerCase();

        return (
          (!searchLaw || lawName === searchLaw.toLowerCase()) &&
          (
            articleNumber === searchArticle.toLowerCase() ||
            label.includes(`artikel ${searchArticle.toLowerCase()}`)
          )
        );
      });

      if (exact) {
        top = exact;
      } else {
        return res.status(200).json({
          answer: `Ik kan artikel ${searchArticle} niet goed vinden. Controleer het artikelnummer.`,
          sources: []
        });
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
    }

    // 5) Niet-artikelvraag: korte AI-uitleg op basis van beste bronnen
    const limited = results.slice(0, 2);
    const context = limited
      .map((r, i) => `[${i + 1}] ${r.label}\n${cleanLegalText(r.text || r.excerpt || "")}`)
      .join("\n\n");

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 320,
        messages: [
          {
            role: "system",
            content: `
Je bent Beleidsbank, een juridische assistent.

Regels:
1. Gebruik alleen de bronpassages.
2. Voeg geen nieuwe wetsartikelen toe.
3. Houd het antwoord kort en duidelijk.
4. Als het niet direct uit de bron volgt, zeg dat.

Schrijf in het Nederlands.
`.trim()
          },
          {
            role: "user",
            content: `Vraag: ${rawQuestion}

Bronnen:
${context}`
          }
        ]
      })
    });

    const aiJson = await aiResp.json();
    const answer =
      aiJson?.choices?.[0]?.message?.content ||
      "Ik kan dit niet goed beantwoorden op basis van de gevonden artikelen.";

    return res.status(200).json({
      answer,
      sources: limited.map(r => ({
        title: r.label,
        link: r.source_url
      }))
    });

  } catch (e) {
    return res.status(500).json({
      error: "chat crashed",
      details: String(e?.message || e)
    });
  }
};
