// beleidsbank-api/api/ingest-all.js
// Bulk ingest driver: haalt BWBR IDs uit SRU (BWB) en kan optioneel ingest-bwb triggeren.
//
// GET /api/ingest-all?startRecord=1&maximumRecords=25
// Optioneel: &ingest=1&limit=60&offset=0&maxCalls=6

function safeInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function toBool(v) {
  const s = (v ?? "").toString().toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes";
}

function parseSruRecords(xml) {
  const ids = [];
  const titles = new Map();
  const types = new Map();

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

  const nextm = xml.match(/<nextRecordPosition>\s*(\d+)\s*<\/nextRecordPosition>/i);
  const nextRecordPosition = nextm ? parseInt(nextm[1], 10) : null;

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
  // Praktisch: pak alles uit BWB. Verdragen zijn vaak BWBV-ids; die filteren we later toch weg.
  // Als je verdragen echt wil: include_verdrag=1 en dan laten we BWBV ook door.
  // We houden query simpel om SRU errors te vermijden.
  return includeVerdrag ? "*" : "*";
}

async function fetchSruXml(url, ms = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        // ✅ SRU endpoint is picky; dit voorkomt veel 406-gedoe
        Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
      },
    });

    const text = await r.text();

    // ✅ SRU kan 406 geven maar tóch een geldige searchRetrieveResponse terugsturen.
    const looksLikeSru = /<searchRetrieveResponse\b/i.test(text);

    if (!r.ok && !looksLikeSru) {
      return { ok: false, status: r.status, text };
    }
    return { ok: true, status: r.status, text };
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
    const maximumRecords = Math.min(50, Math.max(1, safeInt(req.query.maximumRecords, 25)));
    const includeVerdrag = toBool(req.query.include_verdrag);
    const doIngest = toBool(req.query.ingest);

    const limit = Math.min(60, Math.max(5, safeInt(req.query.limit, 60)));
    const offset = Math.max(0, safeInt(req.query.offset, 0));
    const maxCalls = Math.min(10, Math.max(1, safeInt(req.query.maxCalls, 6)));

    const query = buildSruQuery({ includeVerdrag });

    const sruUrl =
      `https://zoekservice.overheid.nl/sru/Search` +
      `?operation=searchRetrieve` +
      `&version=2.0` +
      `&x-connection=BWB` +
      `&query=${encodeURIComponent(query)}` +
      `&startRecord=${startRecord}` +
      `&maximumRecords=${maximumRecords}`;

    const sruResp = await fetchSruXml(sruUrl, 25000);
    if (!sruResp.ok) {
      return res.status(500).json({
        error: "SRU fetch failed",
        status: sruResp.status,
        preview: sruResp.text.slice(0, 800),
      });
    }

    const parsed = parseSruRecords(sruResp.text);

    // BWBR = regelingen, BWBV = verdragen. Als includeVerdrag=0, filter BWBV weg.
    const ids = parsed.ids.filter(id => includeVerdrag ? (/^(BWBR|BWBV)\d+/i.test(id)) : (/^BWBR\d+/i.test(id)));

    // Upsert docs metadata
    const docs = ids.map(id => ({
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

    // Optioneel: trigger ingest-bwb voor deze batch (serverless-safe maxCalls)
    const ingestResults = [];
    if (doIngest) {
      const proto = (req.headers["x-forwarded-proto"] || "https").toString();
      const host = req.headers.host;
      const baseUrl = `${proto}://${host}`;

      let calls = 0;
      for (const id of ids) {
        if (calls >= maxCalls) break;
        calls++;

        const ingestUrl =
          `${baseUrl}/api/ingest-bwb` +
          `?id=${encodeURIComponent(id)}` +
          `&limit=${limit}` +
          `&offset=${offset}`;

        const r = await fetchSruXml(ingestUrl, 25000); // re-use timeout+fetch
        let json = null;
        try { json = JSON.parse(r.text); } catch {}

        ingestResults.push({
          id,
          ok: !!(json && json.ok === true),
          status: r.status,
          preview: json || r.text.slice(0, 200),
          next: json?.next || null
        });
      }
    }

    return res.status(200).json({
      ok: true,
      sru_http_status: sruResp.status,
      sru: {
        startRecord,
        maximumRecords,
        includeVerdrag,
        numberOfRecords: parsed.numberOfRecords,
        nextRecordPosition: parsed.nextRecordPosition,
      },
      batch: {
        count: ids.length,
        ids,
      },
      ingest: doIngest
        ? { called: ingestResults.length, maxCalls, limit, offset, results: ingestResults }
        : { enabled: false },
      next: parsed.nextRecordPosition
        ? `/api/ingest-all?startRecord=${parsed.nextRecordPosition}&maximumRecords=${maximumRecords}&include_verdrag=${includeVerdrag ? 1 : 0}&ingest=${doIngest ? 1 : 0}&limit=${limit}&offset=${offset}&maxCalls=${maxCalls}`
        : null,
    });
  } catch (e) {
    return res.status(500).json({ error: "ingest-all crashed", details: String(e?.message || e) });
  }
};
