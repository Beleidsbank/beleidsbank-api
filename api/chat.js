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
  const q = (text || "").toLowerCase();
  return (
    /artikel\s+[0-9a-z.:-]+/i.test(q) ||
    /\bart\.?\s*[0-9a-z.:-]+/i.test(q) ||
    /\b[0-9]+(?::|\.)[0-9a-z.-]+\b/i.test(q)
  );
}

function isFollowUpQuestion(text) {
  const q = (text || "").toLowerCase();
  return [
    "kan je dit samenvatten",
    "kun je dit samenvatten",
    "vat dit samen",
    "samenvat",
    "samenvatten",
    "leg dit uit",
    "leg uit",
    "in simpele taal",
    "korter",
    "in 2 regels",
    "in twee regels",
    "wat betekent dit",
    "in de praktijk",
    "wanneer geldt dit niet",
    "herschrijf",
    "voor een rapport",
    "maak hier",
    "kort samen"
  ].some(p => q.includes(p));
}

function extractLastSourceContext(history) {
  const msgs = [...history].reverse();

  let lastAssistantWithSources = null;
  for (const msg of msgs) {
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.includes("Bronnen:")) {
      lastAssistantWithSources = msg.content;
      break;
    }
  }

  if (!lastAssistantWithSources) return null;

  const parts = lastAssistantWithSources.split("Bronnen:");
  const answerText = (parts[0] || "").trim();
  const sourcesText = (parts[1] || "").trim();

  const sourceLines = sourcesText
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    answerText,
    sourcesText,
    sourceLines
  };
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
      .slice(-16)
      .map(m => ({
        role: m.role,
        content: String(m.content).slice(0, 3000)
      }));

    const lowerQ = rawQuestion.toLowerCase();
    const followUp = isFollowUpQuestion(rawQuestion);
    const lawInQuestion = detectLaw(rawQuestion);
    const lastContext = extractLastSourceContext(safeHistory);

    // 1. Onduidelijke artikelvraag -> eerst doorvragen
    if (hasArticleReference(rawQuestion) && !lawInQuestion) {
      return res.status(200).json({
        answer: "Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
        sources: []
      });
    }

    // 2. Follow-up op bestaand artikel/antwoord -> GEEN nieuwe search
    if (followUp && lastContext?.answerText) {
      const followUpSystem = `
Je bent Beleidsbank.

Je bewerkt of legt alleen de aangeleverde tekst uit.
Gebruik uitsluitend de aangeleverde tekst en voeg geen nieuwe juridische informatie of nieuwe artikelen toe.

Regels:
1. Blijf volledig binnen de aangeleverde tekst.
2. Voeg geen nieuwe bronnen of wetsartikelen toe.
3. Als de gebruiker vraagt om een samenvatting: vat samen.
4. Als de gebruiker vraagt om uitleg in simpele taal: leg simpel uit.
5. Als de gebruiker vraagt "wat betekent dit in de praktijk": leg praktisch uit, maar alleen op basis van de tekst.
6. Als de gebruiker vraagt "wanneer geldt dit niet" en dat staat niet in de tekst, zeg exact:
"Dat volgt niet direct uit de eerder gevonden artikeltekst."
7. Houd het antwoord kort en helder.
8. Noem niet dat je een AI bent.

Schrijf in het Nederlands.
`.trim();

      const followUpResp = await fetch("https://api.openai.com/v1/chat/completions", {
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
            { role: "system", content: followUpSystem },
            {
              role: "user",
              content:
`Gebruikersvraag:
${rawQuestion}

Eerder gevonden tekst:
${lastContext.answerText}`
            }
          ]
        })
      });

      const followUpText = await followUpResp.text();
      const followUpJson = safeJsonParse(followUpText);
      const answer = stripModelLeakage(followUpJson?.choices?.[0]?.message?.content || "").trim();

      return res.status(200).json({
        answer: answer || "Dat volgt niet direct uit de eerder gevonden artikeltekst.",
        sources: []
      });
    }

    // 3. Zoekquery maken met context
    const rewriteSystem = `
Je zet een gebruikersvraag plus chatgeschiedenis om naar één korte juridische zoekquery.

BELANGRIJK:
1. Combineer context uit eerdere berichten.
2. Als gebruiker eerst een artikel noemt en daarna een wet noemt, combineer die context.
3. Als gebruiker alleen een wet noemt als antwoord op een eerdere artikelvraag, combineer die met het laatst genoemde artikel.
4. Als gebruiker een nieuwe zelfstandige vraag stelt, gebruik alleen die vraag.
5. Bij follow-up zoals "dit", "deze", "samenvatten" of "leg uit" mag je alleen context meenemen als het duidelijk over hetzelfde artikel gaat.

Voorbeelden:
- "artikel 1:3" + "Awb" -> "artikel 1:3 awb"
- "artikel 1.3" + "Omgevingswet" -> "artikel 1.3 omgevingswet"
- "wat is belanghebbende" + "Awb" -> "belanghebbende awb"
- "Geef nu die van AWB" na "artikel 1.3" -> "artikel 1.3 awb"

Regels:
- Geef alleen de zoekquery terug
- Geen uitleg
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
        max_tokens: 50,
        messages: rewriteMessages
      })
    });

    const rewriteText = await rewriteResp.text();
    const rewriteJson = safeJsonParse(rewriteText);
    const searchQuery =
      rewriteJson?.choices?.[0]?.message?.content?.trim() || rawQuestion;

    // 4. Search
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

    // 5. Directe artikelvraag -> artikel tonen
    if (hasArticleReference(searchQuery)) {
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

    // 6. Normale inhoudelijke vraag
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
2. Gebruik maximaal 2 artikelen.
3. Gebruik alleen de meest relevante artikelen.
4. Voeg geen extra artikelen toe voor context.
5. Als je twijfelt: niet noemen.
6. Gebruik zo veel mogelijk formuleringen die dicht bij de wetstekst blijven.

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
            content:
`Vraag: ${rawQuestion}

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
