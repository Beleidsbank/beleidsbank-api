// /api/chat.js — Beleidsbank V1 (works-now version)
// One endpoint. Flow:
// 1) User question -> OpenAI "planner" (JSON) decides: BWB/CVDR search terms + (optional) municipality.
// 2) SRU search BWB + (optional) CVDR -> pick best candidates -> fetch excerpts from the exact source URLs.
// 3) OpenAI "answerer" writes an answer USING ONLY the provided excerpts and adds inline citations [1],[2]...
// 4) Response returns { answer, sources } where sources are EXACTLY the documents we fetched excerpts from.
//
// Requirements met:
// - AI decides where/how to search (no hardcoded dakkapel/markt lists)
// - Sources are real and shown
// - Answer cites only those sources
// - If uncertain, answer stays cautious and points to sources
//
// Notes:
// - In-memory cache is best-effort on serverless.
// - You should generate a NEW session_id per new chat client-side to avoid mixing context.

const SRU_BWB_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search"; // x-connection=BWB
const SRU_CVDR_ENDPOINT = "https://zoekdienst.overheid.nl/sru/Search"; // x-connection=cvdr

const ALLOW_ORIGIN = "https://app.beleidsbank.nl";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const MAX_MESSAGE_CHARS = 2000;
const MAX_SRU_RECORDS = 25;

const MAX_UI_SOURCES = 8;        // returned to UI
const MAX_EXCERPTS_FETCH = 6;    // how many we fetch+use for answer
const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;

const rateStore = new Map();     // ip -> {count, resetAt}
const excerptCache = new Map();  // key -> {value, expiresAt}

function nowMs() { return Date.now(); }

function cleanupStores() {
  const now = nowMs();
  for (const [ip, v] of rateStore.entries()) {
    if (!v || now > (v.resetAt + RATE_WINDOW_MS * 2)) rateStore.delete(ip);
  }
  for (const [k, v] of excerptCache.entries()) {
    if (!v || now > v.expiresAt) excerptCache.delete(k);
  }
}

function rateLimit(ip) {
  const now = nowMs();
  const item = rateStore.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + RATE_WINDOW_MS;
  }
  item.count++;
  rateStore.set(ip, item);
  return item.count <= RATE_LIMIT;
}

function makeFetchWithTimeout() {
  return async function fetchWithTimeout(url, options = {}, ms = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, {
        redirect: "follow",
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "Beleidsbank/1.0 (+https://beleidsbank.nl)",
          ...(options.headers || {}),
        },
      });
    } finally {
      clearTimeout(id);
    }
  };
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function normalize(s) {
  return (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = normalize(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
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
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#([0-9]+);/g, (_, num) => {
      try { return String.fromCodePoint(parseInt(num, 10)); } catch { return ""; }
    });
}

function firstMatch(text, regex) {
  const m = (text || "").match(regex);
  return m ? m[1] : null;
}

async function callOpenAI({ apiKey, fetchWithTimeout, messages, max_tokens = 600, temperature = 0.2 }) {
  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature,
        max_tokens,
        messages,
      }),
    },
    20000
  );

  const raw = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, raw };
  try {
    const json = JSON.parse(raw);
    return { ok: true, content: (json?.choices?.[0]?.message?.content || "").trim() };
  } catch (e) {
    return { ok: false, status: 500, raw: `JSON parse failed: ${String(e)}\nRAW:\n${raw}` };
  }
}

function sanitizeInlineCitations(answer, maxN) {
  if (!answer) return answer;
  const cleaned = answer.replace(/\[(\d+)\]/g, (m, n) => {
    const i = parseInt(n, 10);
    if (Number.isFinite(i) && i >= 1 && i <= maxN) return m;
    return "";
  });
  return cleaned.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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

// ---------- SRU search + parsing ----------

async function sruSearch({ endpoint, connection, cql, fetchWithTimeout, maximumRecords = MAX_SRU_RECORDS, startRecord = 1 }) {
  const url =
    `${endpoint}?version=1.2&operation=searchRetrieve` +
    `&x-connection=${encodeURIComponent(connection)}` +
    `&x-info-1-accept=any` +
    `&startRecord=${startRecord}&maximumRecords=${maximumRecords}` +
    `&query=${encodeURIComponent(cql)}`;

  const resp = await fetchWithTimeout(url, {}, 12000);
  return await resp.text();
}

function parseSruRecords(xml, collectionType) {
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

    const docTypeRaw =
      firstMatch(rec, /<dcterms:type>([^<]+)<\/dcterms:type>/) ||
      firstMatch(rec, /<type>([^<]+)<\/type>/);

    const docType = docTypeRaw ? normalize(decodeXmlEntities(docTypeRaw)) : null;

    if (!id || !title) continue;
    if (collectionType === "BWB" && !/^BWBR/i.test(id)) continue;
    if (collectionType === "CVDR" && !/^CVDR/i.test(id)) continue;

    const link =
      collectionType === "BWB"
        ? `https://wetten.overheid.nl/${id}`
        : `https://lokaleregelgeving.overheid.nl/${id}`;

    out.push({ id, title, link, type: collectionType, docType });
  }

  // de-dupe by link
  const seen = new Set();
  return out.filter((x) => {
    if (!x.link || seen.has(x.link)) return false;
    seen.add(x.link);
    return true;
  });
}

// ---------- HTML -> excerpt ----------

function htmlToTextLite(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6|tr|td)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildExcerpt(text, terms, maxChars = 2200) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const termSet = uniq((terms || []).map(normalize)).filter((t) => t && t.length >= 3);
  if (!termSet.length) return lines.slice(0, 24).join("\n").slice(0, maxChars);

  // score lines by term hits
  const scored = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = normalize(lines[i]);
    let s = 0;
    for (const t of termSet) if (ln.includes(t)) s++;
    if (s > 0) scored.push({ i, s });
  }

  if (!scored.length) return lines.slice(0, 30).join("\n").slice(0, maxChars);

  scored.sort((a, b) => b.s - a.s);

  const idx = new Set();
  for (const it of scored.slice(0, 12)) {
    idx.add(it.i);
    if (it.i > 0) idx.add(it.i - 1);
    if (it.i + 1 < lines.length) idx.add(it.i + 1);
  }

  const ordered = [...idx].sort((a, b) => a - b).map((i) => lines[i]);
  let excerpt = ordered.join("\n");
  if (excerpt.length > maxChars) excerpt = excerpt.slice(0, maxChars);
  return excerpt;
}

async function fetchExcerpt({ src, terms, fetchWithTimeout }) {
  const cacheKey = `ex:${src.type}:${src.id}:${terms.map(normalize).join("|").slice(0, 120)}`;
  const cached = excerptCache.get(cacheKey);
  if (cached && nowMs() < cached.expiresAt) return cached.value;

  try {
    // try to keep it light
    const resp = await fetchWithTimeout(src.link, { headers: { Range: "bytes=0-450000" } }, 15000);
    const html = await resp.text();
    const text = htmlToTextLite(html.length > 950000 ? html.slice(0, 950000) : html);
    const ex = buildExcerpt(text, terms, 2200);
    const value = ex || null;
    excerptCache.set(cacheKey, { value, expiresAt: nowMs() + EXCERPT_TTL_MS });
    return value;
  } catch {
    excerptCache.set(cacheKey, { value: null, expiresAt: nowMs() + 15 * 60 * 1000 });
    return null;
  }
}

// ---------- Ranking (generic; no hardcoded topics) ----------

const QUALITY_PENALTY_WORDS = [
  "invoerings",
  "verzamel",
  "wijzigings",
  "aanvullings",
  "instellingsbesluit",
  "mandaatbesluit",
  "regeling gebruik van frequentieruimte",
  "frequentieruimte",
  "kansspelen",
  "telecom",
  "gsm",
  "gas aan kleinverbruikers",
  "elektriciteit aan kleinverbruikers",
  "sportprijsvragen",
];

function scoreSourceGeneric(src, plan) {
  const title = normalize(src.title);
  const terms = (plan?.search_terms || []).map(normalize);

  let score = 0;
  score += src.type === "BWB" ? 3 : 2;

  // reward hits of search terms
  for (const t of terms) if (t && title.includes(t)) score += 3;

  // demote common noise
  const allTerms = terms.join(" ");
  for (const pw of QUALITY_PENALTY_WORDS) {
    const p = normalize(pw);
    if (p && title.includes(p) && !allTerms.includes(p)) score -= 6;
  }

  // mild reward for likely “primary” local docs
  if (title.includes("verordening")) score += 1.5;
  if (title.includes("algemene plaatselijke verordening") || title.includes("apv")) score += 2.5;
  if (title.includes("omgevingswet")) score += 3;
  if (title.includes("besluit bouwwerken leefomgeving") || title.includes("bbl")) score += 2.5;
  if (title.includes("omgevingsbesluit")) score += 2;

  return score;
}

function pickTopCandidates(all, plan, max = 20) {
  const scored = (all || []).map((s) => ({ ...s, _score: scoreSourceGeneric(s, plan) }));
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  return scored.slice(0, max);
}

// ---------- Planner + Answerer prompts ----------

async function aiPlanSearch({ apiKey, fetchWithTimeout, question }) {
  const system = `
Je bent Beleidsbank (retrieval planner) voor Nederlandse wet- en regelgeving en beleid.
Taak: bepaal hoe we officiële bronnen moeten zoeken (BWB en eventueel CVDR).

Geef ALLEEN JSON met dit schema:
{
  "search_terms": string[],          // 5-10 kerntermen (geen stopwoorden)
  "use_bwb": boolean,                // meestal true
  "use_cvdr": boolean,               // true als lokale regels waarschijnlijk relevant zijn
  "municipality": string|null,       // als expliciet genoemd in de vraag, anders null
  "cvdr_topic_terms": string[],      // 3-6 termen voor CVDR (als use_cvdr)
  "bwb_cql": string                  // CQL query voor BWB SRU (veilig, met titel any)
}

Regels:
- Gebruik GEEN lijsten met specifieke voorbeelden (geen hardcoded dakkapel/markt etc.). Leid termen af uit de vraag.
- Als de vraag over gemeentelijke regels kan gaan maar geen gemeente bevat: zet use_cvdr=true, municipality=null.
- bwb_cql: gebruik vooral overheidbwb.titel any "<term>" OR ...
- Houd bwb_cql compact (max ~600 tekens).
`.trim();

  const user = `Vraag:\n${question}`;

  const r = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 450,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  if (!r.ok) return null;
  const plan = safeJsonParse(r.content);
  if (!plan || typeof plan !== "object") return null;

  // minimal validation / hardening
  const search_terms = Array.isArray(plan.search_terms) ? uniq(plan.search_terms).slice(0, 10) : [];
  const cvdr_topic_terms = Array.isArray(plan.cvdr_topic_terms) ? uniq(plan.cvdr_topic_terms).slice(0, 6) : [];
  const use_bwb = plan.use_bwb !== false;
  const use_cvdr = !!plan.use_cvdr;
  const municipality = (plan.municipality && String(plan.municipality).trim()) ? String(plan.municipality).trim() : null;

  let bwb_cql = typeof plan.bwb_cql === "string" ? plan.bwb_cql.trim() : "";
  // If planner forgot cql, build a safe default
  if (!bwb_cql) {
    const terms = search_terms.slice(0, 7).map(t => t.replaceAll('"', ""));
    bwb_cql = terms.length
      ? `(${terms.map(t => `overheidbwb.titel any "${t}"`).join(" OR ")})`
      : `overheidbwb.titel any "Omgevingswet"`;
  }
  if (bwb_cql.length > 700) bwb_cql = bwb_cql.slice(0, 700);

  return { search_terms, use_bwb, use_cvdr, municipality, cvdr_topic_terms, bwb_cql };
}

async function aiAnswer({ apiKey, fetchWithTimeout, question, plan, sources }) {
  const system = `
Je bent Beleidsbank, assistent voor Nederlandse wet- en regelgeving en beleid.

Je krijgt:
- de vraag
- een lijst bronnen [1..N] met korte uittreksels uit officiële bronnen

Doel:
- Geef een globaal, praktisch, voorzichtig antwoord in het Nederlands.
- Gebruik inline bronverwijzingen [1], [2], ... ALLEEN wanneer de bewering steun vindt in het excerpt van die bron.
- Als een detail niet zeker blijkt uit excerpts: zeg dat expliciet en verwijs naar de meest relevante bron(nen) om na te lezen.
- Als use_cvdr waarschijnlijk is maar municipality ontbreekt: zeg dat lokale regels per gemeente verschillen en dat men kan zoeken op lokaleregelgeving.overheid.nl.

Verboden:
- Geen meta-tekst (geen "als AI", geen trainingsdata).
- Verzin geen artikelnummers als ze niet letterlijk in excerpts staan.

Output: schrijf gewone tekst (geen JSON).
`.trim();

  const payload = {
    question,
    plan,
    sources: (sources || []).map((s, idx) => ({
      n: idx + 1,
      id: s.id,
      title: s.title,
      link: s.link,
      type: s.type,
      excerpt: s.excerpt || "",
    })),
  };

  const r = await callOpenAI({
    apiKey,
    fetchWithTimeout,
    max_tokens: 900,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  if (!r.ok) return null;
  return r.content;
}

// ---------- Handler ----------

export default async function handler(req, res) {
  cleanupStores();

  // CORS
  const origin = (req.headers.origin || "").toString();
  res.setHeader("Access-Control-Allow-Origin", origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!rateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  const body = typeof req.body === "string" ? safeJsonParse(req.body) || {} : req.body || {};
  const message = (body.message || body.messages?.at(-1)?.content || "").toString().trim();
  if (!message) return res.status(400).json({ error: "Missing message" });
  if (message.length > MAX_MESSAGE_CHARS) return res.status(413).json({ error: "Message too long" });

  const fetchWithTimeout = makeFetchWithTimeout();

  // 1) AI decides how to search
  const plan = await aiPlanSearch({ apiKey, fetchWithTimeout, question: message });

  // If planner fails, do a safe fallback that still returns real sources
  const safePlan = plan || {
    search_terms: uniq(message.split(/\s+/)).slice(0, 8),
    use_bwb: true,
    use_cvdr: true,
    municipality: null,
    cvdr_topic_terms: uniq(message.split(/\s+/)).slice(0, 5),
    bwb_cql: `overheidbwb.titel any "Omgevingswet"`,
  };

  // 2) SRU searches
  let bwb = [];
  let cvdr = [];

  if (safePlan.use_bwb) {
    try {
      const xml = await sruSearch({
        endpoint: SRU_BWB_ENDPOINT,
        connection: "BWB",
        cql: safePlan.bwb_cql,
        fetchWithTimeout,
      });
      bwb = parseSruRecords(xml, "BWB");
    } catch { bwb = []; }
  }

  // CVDR: only if municipality known; otherwise we still keep use_cvdr as a "note to user"
  if (safePlan.use_cvdr && safePlan.municipality) {
    try {
      const mun = safePlan.municipality.replaceAll('"', "");
      const topicTerms = (safePlan.cvdr_topic_terms || safePlan.search_terms || []).slice(0, 6).map(t => t.replaceAll('"', ""));
      const topic = topicTerms.join(" ").trim() || mun;

      const creatorClause = `(dcterms.creator="${mun}" OR dcterms.creator="Gemeente ${mun}")`;
      const contentClause = topic
        ? `(keyword all "${topic}")`
        : `(title any "verordening")`;

      const cql = `(${creatorClause} AND ${contentClause})`;

      const xml = await sruSearch({
        endpoint: SRU_CVDR_ENDPOINT,
        connection: "cvdr",
        cql,
        fetchWithTimeout,
      });
      cvdr = parseSruRecords(xml, "CVDR");
    } catch { cvdr = []; }
  }

  const candidates = pickTopCandidates([...bwb, ...cvdr], safePlan, 20);

  // 3) Fetch excerpts from EXACT candidate URLs
  const termsForExcerpt = uniq([...(safePlan.search_terms || []), ...(safePlan.cvdr_topic_terms || [])]).slice(0, 12);
  const toFetch = candidates.slice(0, MAX_EXCERPTS_FETCH);

  const fetched = [];
  for (const src of toFetch) {
    const excerpt = await fetchExcerpt({ src, terms: termsForExcerpt, fetchWithTimeout });
    fetched.push({ ...src, excerpt: (excerpt || "").trim() });
  }

  // Keep only sources where we actually have some excerpt text (still real sources)
  const used = fetched.filter(s => (s.excerpt || "").length >= 40);
  const usedSources = used.length ? used : fetched; // if all failed, still return links (but excerpts may be empty)

  // 4) Answer using ONLY those sources
  let answer = "";
  const ai = await aiAnswer({ apiKey, fetchWithTimeout, question: message, plan: safePlan, sources: usedSources });

  if (ai) {
    answer = sanitizeInlineCitations(stripModelLeakage(ai), usedSources.length);
  } else {
    answer =
      "Ik kon op dit moment geen antwoord genereren op basis van de opgehaalde uittreksels. " +
      "Bekijk de onderstaande bronnen om de relevante bepalingen te vinden.";
    if (safePlan.use_cvdr && !safePlan.municipality) {
      answer += " Let op: lokale regels verschillen per gemeente. Voeg de gemeente toe voor lokale regelgeving.";
    }
  }

  // 5) Return sources (REAL sources we fetched from)
  const sourcesOut = usedSources.slice(0, MAX_UI_SOURCES).map((s) => ({
    id: s.id,
    title: s.title,
    link: s.link,
    type: s.type,        // "BWB" or "CVDR"
    excerpt: s.excerpt || "",
  }));

  return res.status(200).json({
    answer,
    sources: sourcesOut,
    debug_plan: plan ? undefined : { note: "planner_failed_used_fallback", safePlan }, // remove if you don't want debug
  });
}
