// /pages/api/chat.js — Beleidsbank V1 (robust, relevant sources only, CORS-safe, no placeholders)
//
// Response: { answer: string, sources: [{n,title,link,type}] }

export const config = {
  api: { bodyParser: true },
};

const BWB_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search"; // x-connection=BWB
const CVDR_ENDPOINT = "https://zoekdienst.overheid.nl/sru/Search"; // x-connection=cvdr

const ALLOW_ORIGIN = "https://app.beleidsbank.nl"; // pas aan indien nodig
const MAX_MESSAGE_CHARS = 2000;

const SRU_MAX_RECORDS = 50;
const MAX_CANDIDATES = 80;
const EXCERPTS_FETCH = 16;
const MAX_FINAL = 6;

const TITLE_DEMOTE = [
  "aanwijzingsbesluit",
  "intrekking",
  "preventief",
  "fouilleren",
  "mandaat",
  "invoerings",
  "wijziging",
  "verzamel",
];

const TITLE_NOISE = [
  "inkomstenbelasting",
  "kapitaalverzekering",
  "spaarrekening",
  "beleggingsrecht",
  "box 3",
  "kew",
  "overgangstermijn",
];

function nowMs() { return Date.now(); }

function normalize(s) {
  return (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function decodeXmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function firstMatch(text, re) {
  const m = (text || "").match(re);
  return m ? m[1] : null;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function extractTerms(q, max = 12) {
  const raw = (q || "")
    .toString()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = raw.split(" ").map(t => normalize(t)).filter(Boolean);
  const stop = new Set([
    "de","het","een","en","of","maar","als","dan","dat","dit","die","er","hier","daar","waar","wanneer",
    "ik","jij","je","u","uw","we","wij","zij","ze","mijn","jouw","zijn","haar","hun","ons","onze",
    "mag","mogen","moet","moeten","kun","kunnen","kan","zal","zullen","wil","willen",
    "zonder","met","voor","van","op","in","aan","bij","naar","tot","tegen","over","door","om","uit","binnen",
    "wat","welke","wie","waarom","hoe","hoelang","hoeveel","wel","niet","geen","ja",
    "wet","beleid","regels","regel","verordening","toestemming","vergunning","aanvraag","aanvragen",
  ]);

  const out = [];
  const seen = new Set();
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (/^\d+$/.test(t)) continue;
    if (stop.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function extractMunicipality(q) {
  const text = (q || "").toString();
  let m = text.match(/\bgemeente\s+([A-Za-zÀ-ÿ'\-]+(?:\s+[A-Za-zÀ-ÿ'\-]+){0,3})/i);
  if (m?.[1]) return m[1].trim();
  m = text.match(/\b(?:in|te|bij)\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+){0,3})/);
  if (m?.[1]) return m[1].trim();
  return null;
}

function makeFetchWithTimeout() {
  return async (url, options = {}, ms = 15000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, {
        redirect: "follow",
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "Beleidsbank/1.0 (+https://beleidsbank.nl)",
          "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.7",
          ...(options.headers || {}),
        },
      });
    } finally {
      clearTimeout(id);
    }
  };
}

async function sruSearch({ endpoint, connection, cql, fetchWithTimeout }) {
  const url =
    `${endpoint}?version=1.2&operation=searchRetrieve` +
    `&x-connection=${encodeURIComponent(connection)}` +
    `&x-info-1-accept=any` +
    `&startRecord=1&maximumRecords=${SRU_MAX_RECORDS}` +
    `&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url, {}, 15000);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`SRU ${connection} HTTP ${resp.status}`);
  return text;
}

function parseSruRecords(xml, type) {
  const records = (xml || "").match(/<record(?:\s[^>]*)?>[\s\S]*?<\/record>/g) || [];
  const out = [];

  for (const rec of records) {
    const id =
      firstMatch(rec, /<dcterms:identifier>([^<]+)<\/dcterms:identifier>/) ||
      firstMatch(rec, /<identifier>([^<]+)<\/identifier>/);

    const titleRaw =
      firstMatch(rec, /<dcterms:title>([\s\S]*?)<\/dcterms:title>/) ||
      firstMatch(rec, /<title>([\s\S]*?)<\/title>/);

    const title = decodeXmlEntities((titleRaw || "").replace(/<[^>]+>/g, "").trim());
    if (!id || !title) continue;

    if (type === "BWB" && !/^BWBR/i.test(id)) continue;
    if (type === "CVDR" && !/^CVDR/i.test(id)) continue;

    const link = type === "BWB"
      ? `https://wetten.overheid.nl/${id}`
      : `https://lokaleregelgeving.overheid.nl/${id}`;

    out.push({ id, title, link, type });
  }

  return out;
}

function scoreSource(src, terms, municipality) {
  const t = normalize(src.title);
  let score = 0;

  score += src.type === "CVDR" ? 6 : 3;
  if (municipality && src.type === "CVDR") score += 6;

  // boost “regelsets”
  if (src.type === "CVDR" && (t.includes("algemene plaatselijke verordening") || t.includes(" apv"))) score += 25;
  if (src.type === "CVDR" && (t.includes("verordening") || t.includes("beleidsregel"))) score += 12;

  // match terms in title
  for (const term of terms || []) {
    if (term && t.includes(term)) score += 8;
  }

  // demote noisy titles
  for (const w of TITLE_DEMOTE) if (t.includes(w)) score -= 15;
  for (const w of TITLE_NOISE) if (t.includes(w)) score -= 200;

  return score;
}

function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6|tr|td|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildKeywordWindows(text, keywords, maxWindows = 4, windowLines = 10, maxChars = 2800) {
  const lines = (text || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return "";

  const keys = (keywords || []).map(normalize).filter(k => k && k.length >= 3);
  if (!keys.length) return lines.slice(0, 80).join("\n").slice(0, maxChars);

  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const lc = normalize(lines[i]);
    if (keys.some(k => lc.includes(k))) hits.push(i);
  }
  if (!hits.length) return lines.slice(0, 100).join("\n").slice(0, maxChars);

  const picked = [];
  for (const idx of hits) {
    if (!picked.length || Math.abs(idx - picked[picked.length - 1]) > windowLines * 2) {
      picked.push(idx);
      if (picked.length >= maxWindows) break;
    }
  }

  const chunks = [];
  for (const center of picked) {
    const start = Math.max(0, center - windowLines);
    const end = Math.min(lines.length, center + windowLines + 1);
    chunks.push(lines.slice(start, end).join("\n"));
  }

  let out = chunks.join("\n\n---\n\n");
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

async function fetchExcerpt(src, keywords, fetchWithTimeout) {
  try {
    // geen Range → betrouwbaarder; als performance issue, later tunen
    const resp = await fetchWithTimeout(src.link, {}, 20000);
    const html = await resp.text();
    if (!resp.ok) return "";

    const cut = html.length > 2_500_000 ? html.slice(0, 2_500_000) : html;
    const text = decodeXmlEntities(htmlToTextLite(cut));
    return buildKeywordWindows(text, keywords, 4, 10, 2800);
  } catch {
    return "";
  }
}

function hitCount(excerpt, terms) {
  const ex = normalize(excerpt || "");
  if (!ex) return 0;
  let c = 0;
  for (const t of terms || []) if (t && ex.includes(t)) c++;
  return c;
}

async function callOpenAI({ apiKey, fetchWithTimeout, question, sources }) {
  const system = `
Je bent Beleidsbank.
Beantwoord de vraag kort en concreet in het Nederlands.

Harde regels:
- Gebruik ALLEEN de meegeleverde bronnen (uittreksels).
- Voeg citations toe als [1], [2], ... (alleen echte nummers).
- Gebruik NOOIT placeholders zoals [n].
- Als iets niet in de uittreksels staat: zeg dat expliciet.
- Geen verzonnen artikel-/lidnummers.

Output: alleen platte tekst (geen JSON).
`.trim();

  const payload = {
    question,
    sources: sources.map(s => ({
      n: s.n,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt,
    })),
  };

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.15,
        max_tokens: 650,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    },
    20000
  );

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${raw.slice(0, 300)}`);

  const json = safeJsonParse(raw);
  return (json?.choices?.[0]?.message?.content || "").trim();
}

function sanitizeAnswer(answer, maxN) {
  let a = (answer || "").replace(/\[n\]/gi, "").trim();
  a = a.replace(/\[(\d+)\]/g, (m, n) => {
    const i = parseInt(n, 10);
    if (Number.isFinite(i) && i >= 1 && i <= maxN) return m;
    return "";
  });
  return stripModelLeakage(a);
}

function stripModelLeakage(text) {
  if (!text) return text;
  return text
    .replace(/you are trained on data up to.*$/gmi, "")
    .replace(/as an ai language model.*$/gmi, "")
    .replace(/als (een )?ai(-| )?taalmodel.*$/gmi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------- handler ----------------------
export default async function handler(req, res) {
  // CORS
  const origin = (req.headers.origin || "").toString();
  res.setHeader("Access-Control-Allow-Origin", origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const body = typeof req.body === "string" ? safeJsonParse(req.body) || {} : (req.body || {});
    const question = (body.message || "").toString().trim();
    if (!question) return res.status(400).json({ error: "Missing message" });
    if (question.length > MAX_MESSAGE_CHARS) return res.status(413).json({ error: "Message too long" });

    const fetchWithTimeout = makeFetchWithTimeout();

    const mun = extractMunicipality(question);
    const terms = extractTerms(question, 12);

    // excerpt keywords: terms + algemene procedure-woorden
    const keywords = uniqBy(
      [...terms, "vergunning", "melding", "ontheffing", "verbod", "voorwaarden", "procedure", "termijn", "aanvraag", "besluit"],
      x => normalize(x)
    ).slice(0, 18);

    // SRU: BWB
    const bwbCql = terms.length
      ? terms.map(t => `overheidbwb.titel any "${t.replaceAll('"', "")}"`).join(" OR ")
      : `overheidbwb.titel any "Algemene wet bestuursrecht"`;

    let bwb = [];
    try {
      const xml = await sruSearch({ endpoint: BWB_ENDPOINT, connection: "BWB", cql: bwbCql, fetchWithTimeout });
      bwb = parseSruRecords(xml, "BWB");
    } catch { bwb = []; }

    // SRU: CVDR (alleen als gemeente herleidbaar)
    let cvdr = [];
    if (mun) {
      const munEsc = mun.replaceAll('"', "");
      const cvdrCql = `(dcterms.creator="${munEsc}" OR dcterms.creator="Gemeente ${munEsc}") AND (title any "verordening" OR title any "Algemene plaatselijke verordening" OR title any "APV" OR title any "beleidsregel")`;
      try {
        const xml = await sruSearch({ endpoint: CVDR_ENDPOINT, connection: "cvdr", cql: cvdrCql, fetchWithTimeout });
        cvdr = parseSruRecords(xml, "CVDR");
      } catch { cvdr = []; }
    }

    // merge + score + top candidates
    let merged = uniqBy([...cvdr, ...bwb], s => `${s.type}:${s.id}`)
      .map(s => ({ ...s, _score: scoreSource(s, terms, mun) }))
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .slice(0, MAX_CANDIDATES);

    // fetch excerpts
    const fetched = [];
    for (const src of merged.slice(0, EXCERPTS_FETCH)) {
      const ex = await fetchExcerpt(src, keywords, fetchWithTimeout);
      const hits = hitCount(ex, terms);
      if (ex && ex.length > 120) fetched.push({ ...src, excerpt: ex, _hits: hits });
    }

    // keep relevant
    let relevant = fetched
      .filter(s => (s._hits || 0) >= 1) // alleen echt onderwerp-match
      .sort((a, b) => ((b._hits || 0) - (a._hits || 0)) || ((b._score || 0) - (a._score || 0)))
      .slice(0, MAX_FINAL);

    // fallback: als term-matches schaars zijn, neem dan de beste excerpts (maar nog steeds geen lege)
    if (relevant.length < 2) {
      relevant = fetched
        .sort((a, b) => ((b._score || 0) - (a._score || 0)))
        .slice(0, Math.min(MAX_FINAL, fetched.length));
    }

    if (!relevant.length) {
      return res.status(200).json({
        answer: "Ik kon geen relevante passages ophalen uit officiële bronnen. Noem (bij lokale regels) de gemeente en wees iets specifieker.",
        sources: [],
      });
    }

    // Renumber contiguous 1..K (cruciaal voor citations)
    const sourcesForAI = relevant.map((s, i) => ({
      n: i + 1,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt,
    }));

    // OpenAI answer (+ retry if citations bad)
    let answer = "";
    try {
      answer = await callOpenAI({ apiKey, fetchWithTimeout, question, sources: sourcesForAI });
      answer = sanitizeAnswer(answer, sourcesForAI.length);

      // retry if still has placeholders or no citations at all
      if (/\[n\]/i.test(answer) || !/\[(\d+)\]/.test(answer)) {
        const a2 = await callOpenAI({ apiKey, fetchWithTimeout, question, sources: sourcesForAI });
        const clean2 = sanitizeAnswer(a2, sourcesForAI.length);
        if (clean2) answer = clean2;
      }
    } catch (e) {
      answer = "Er ging iets mis bij het genereren van het antwoord, maar de relevante bronnen staan hieronder.";
    }

    // ONLY relevant sources (the ones AI had)
    return res.status(200).json({
      answer,
      sources: sourcesForAI.map(s => ({ n: s.n, title: s.title, link: s.link, type: s.type })),
    });
  } catch (e) {
    // Always return JSON (prevents “Load failed”)
    return res.status(500).json({
      error: "Interne fout",
      details: String(e?.message || e),
    });
  }
}
