// Simple in-memory rate limiter (best effort)
const rateStore = new Map();
function rateLimit(ip, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const item = rateStore.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + windowMs;
  }
  item.count += 1;
  rateStore.set(ip, item);
  return { ok: item.count <= limit, remaining: Math.max(0, limit - item.count), resetAt: item.resetAt };
}

export default async function handler(req, res) {
  // CORS: alleen jouw site toestaan
  const allowedOrigins = new Set([
    "https://beleidsbank.nl",
    "https://www.beleidsbank.nl"
  ]);

  const origin = req.headers.origin || "";
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  if (!allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Forbidden (origin not allowed)" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const rl = rateLimit(ip, 10, 60_000);
  if (!rl.ok) return res.status(429).json({ error: "Too many requests. Try again in a minute." });

  const { topic } = req.body || {};

  try {
    const prompt = `
Genereer 4 korte voorbeeldvragen (Nederlands) die passen bij Beleidsbank.nl:
- v1 is landelijk: wetten/regelgeving/beleidsregels
- vragen moeten concreet zijn en goed werken met bronnen (wetten.overheid.nl / Staatscourant)
- max 10 woorden per vraag
- géén dubbele vragen
Geef ALLEEN een JSON array met 4 strings. Geen extra tekst.

Topic (optioneel): ${topic || ""}
`;

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,
        max_tokens: 200,
        messages: [
          { role: "system", content: "Je geeft strikt JSON terug." },
          { role: "user", content: prompt }
        ]
      })
    });

    const aiData = await aiResp.json();
    const text = aiData?.choices?.[0]?.message?.content || "[]";

    // Parse JSON veilig
    let suggestions = [];
    try {
      suggestions = JSON.parse(text);
    } catch (e) {
      suggestions = [];
    }

    // Fallback als AI geen geldige JSON gaf
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      suggestions = [
        "Wet passend onderwijs: wat is de zorgplicht?",
        "Omgevingswet: wanneer participatie verplicht?",
        "Wkb: rol en taken kwaliteitsborger?",
        "Energiebesparingsplicht: wat moet een bedrijf doen?"
      ];
    }

    // Max 4
    suggestions = suggestions.slice(0, 4);

    return res.status(200).json({ suggestions });

  } catch (e) {
    return res.status(500).json({ error: "Interne fout" });
  }
}
