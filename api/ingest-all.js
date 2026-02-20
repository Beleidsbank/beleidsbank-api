// beleidsbank-api/api/ingest-all.js
// Stap 1: Bulk ingest "landelijke regelgeving" via SRU (BWB) + jouw bestaande /api/ingest-bwb
//
// GET /api/ingest-all
//   ?startRecord=1
//   ?maximumRecords=25
//   ?include_verdrag=0
//   ?ingest=1              (optioneel: triggert ingest-bwb per BWBR in deze batch)
//   ?limit=60              (chunk batch size voor ingest-bwb)
//   ?offset=0              (start offset voor ingest-bwb; normaal 0)
//   ?maxCalls=8            (max aantal ingest-bwb calls binnen deze request; serverless-safe)
//
// Let op: "alles" is groot (tienduizenden regelingen). Deze endpoint is bewust paginated.

function safeInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function toBool(v) {
  const s = (v ?? "").toString().toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes";
}

function escapeXmlText(s) {
  return (s || "").toString();
}

// Minimalistische XML parsing (geen dependencies):
function parseSruRecords(xml) {
  // We halen identifier/title/type uit de recordData.
  // Identifiers zijn BWBR... (regelingen) en BWBV... (verdragen).
  const ids = [];
  const titles = new Map();
  const types = new Map();

  // Pak per recordData blok (ruw maar effectief)
  const recordBlocks = xml.match(/<record\b[\s\S]*?<\/record>/gi) || [];
  for (const rec of recordBlocks) {
    const idm = rec.match(/<dcterms:identifier[^>]*>\s*([^<\s]+)\s*<\/dcterms:identifier>/i);
    if (!idm) continue;
    const id = idm[1].trim();
    ids.push(id);

    const tm = rec.match(/<dcterms:title[^>]*>\s*([\s\S]*?)\s*<\/dcterms:title>/i);
    if (tm) titles.set(id, tm[1].replace(/\s+/g, " ").trim());

    const typm = rec.match(/<dcterms:type[^>]*>\s*([\s\S]*?)\s*<\/dcterms:type>/i);
    if (typm) types.set(id, typm[1].replace(/\s+/g, " ").trim());
  }

  // nextRecordPosition
  const nextm = xml.match(/<nextRecordPosition>\s*(\d+)\s*<\/nextRecordPosition>/i);
  const nextRecordPosition = nextm ? parseInt(nextm[1], 10) : null;

  // numberOfRecords
  const nom = xml.match(/<numberOfRecords>\s*(\d+)\s*<\/numberOfRecords>/i);
  const numberOfRecords = nom ? parseInt(nom[1], 10) : null;

  return { ids, titles, types, nextRecordPosition, numberOfRecords };
}

async function supabaseUpsertDocuments({ supabaseUrl, serviceKey, docs }) {
  if (!docs.length) return;

  const url = `${supabaseUrl}/rest/v1/documents?on_conflict=id`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(docs),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase upsert documents failed ${resp.status}: ${text.slice(0, 300)}`);
  }
}

function buildSruQuery({ includeVerdrag }) {
  // Waardenlijst type (bijlage in SRU handleiding): wet, AMvB, ministeriele-regeling, KB, etc. :contentReference[oaicite:2]{index=2}
  // Voor “alles landelijk” pakken we standaard ALLES behalve verdragen, tenzij include_verdrag=1.
  const baseTypes = [
    "wet",
    "AMvB",
    "ministeriele-regeling",
    "KB",
    "zbo",
    "beleidsregel",
    "pbo",
    "circulaire",
  ];

  const types = includeVerdrag ? [...baseTypes, "verdrag"] : baseTypes;

  // CQL OR query: type="wet" or type="AMvB" ...
  return types.map(t => `type="${t}"`).join(" or ");
}

async function fetchWithTimeout(url, ms = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" });

    const startRecord = Math.max(1, safeInt(req.query.startRecord, 1));
    const maximumRecords = Math.min(50, Math.max(1, safeInt(req.query.maximumRecords, 25))); // SRU default 50, max kan hoger maar dit is serverless-safe :contentReference[oaicite:3]{index=3}
    const includeVerdrag = toBool(req.query.include_verdrag);
    const doIngest = toBool(req.query.ingest);

    const limit = Math.min(60, Math.max(5, safeInt(req.query.limit, 60)));
    const offset = Math.max(0, safeInt(req.query.offset, 0));
    const maxCalls = Math.min(20, Math.max(1, safeInt(req.query.maxCalls, 8)));

    const query = buildSruQuery({ includeVerdrag });
    const sruUrl =
      `https://zoekservice.overheid.nl/sru/Search` +
      `?operation=searchRetrieve` +
      `&version=2.0` +
      `&x-connection=BWB` +
      `&query=${encodeURIComponent(query)}` +
      `&startRecord=${startRecord}` +
      `&maximumRecords=${maximumRecords}`;

    const sruResp = await fetchWithTimeout(sruUrl, 25000);
    if (!sruResp.ok) {
      return res.status(500).json({
        error: "SRU fetch failed",
        status: sruResp.status,
        preview: sruResp.text.slice(0, 800),
      });
    }

    const parsed = parseSruRecords(sruResp.text);

    // Alleen BWBR (regelingen). BWBV zijn verdragen.
    const bwbrIds = parsed.ids.filter(id => /^BWBR\d+/i.test(id));

    // Upsert documents metadata (title/type) zodat je later kunt filteren en tonen
    const docs = bwbrIds.map(id => ({
      id,
      title: parsed.titles.get(id) || id,
      type: parsed.types.get(id) || "BWB",
      source_url: `https://wetten.overheid.nl/${id}`,
    }));

    await supabaseUpsertDocuments({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      docs,
    });

    const baseUrl = `https://${req.headers.host}`;

    // Optioneel: trigger ingest-bwb voor deze batch (beperkt aantal calls per request)
    const ingestResults = [];
    if (doIngest) {
      let calls = 0;
      for (const id of bwbrIds) {
        if (calls >= maxCalls) break;
        calls++;

        const ingestUrl =
          `${baseUrl}/api/ingest-bwb` +
          `?id=${encodeURIComponent(id)}` +
          `&limit=${limit}` +
          `&offset=${offset}`;

        const r = await fetchWithTimeout(ingestUrl, 25000);
        const json = r.text ? (JSON.parse(r.text) || null) : null;

        ingestResults.push({
          id,
          ok: r.ok && json?.ok === true,
          status: r.status,
          response: json || { raw: r.text?.slice(0, 300) },
        });
      }
    }

    return res.status(200).json({
      ok: true,
      sru: {
        startRecord,
        maximumRecords,
        includeVerdrag,
        numberOfRecords: parsed.numberOfRecords,
        nextRecordPosition: parsed.nextRecordPosition,
      },
      batch: {
        bwbr_count: bwbrIds.length,
        bwbr_ids: bwbrIds,
      },
      ingest: doIngest
        ? {
            called: ingestResults.length,
            maxCalls,
            limit,
            offset,
            results: ingestResults,
          }
        : { enabled: false },
      next: parsed.nextRecordPosition
        ? `/api/ingest-all?startRecord=${parsed.nextRecordPosition}&maximumRecords=${maximumRecords}&include_verdrag=${includeVerdrag ? 1 : 0}&ingest=${doIngest ? 1 : 0}&limit=${limit}&offset=${offset}&maxCalls=${maxCalls}`
        : null,
    });
  } catch (e) {
    return res.status(500).json({ error: "ingest-all crashed", details: String(e?.message || e) });
  }
};
