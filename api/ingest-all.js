// beleidsbank-api/api/ingest-all.js
// Bulk ingest driver: SRU (BWB) -> lijst BWBR ids -> optioneel ingest-bwb triggeren.

function safeInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function toBool(v) {
  const s = (v ?? "").toString().toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes";
}

// Namespace-safe match helpers
function tagRe(tag) {
  // match <tag> or <ns:tag>
  return new RegExp(`<\\s*(?:[a-z0-9_-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*(?:[a-z0-9_-]+:)?${tag}\\s*>`, "i");
}
function allTagBlocksRe(tag) {
  return new RegExp(`<\\s*(?:[a-z0-9_-]+:)?${tag}\\b[\\s\\S]*?<\\s*\\/\\s*(?:[a-z0-9_-]+:)?${tag}\\s*>`, "gi");
}

function parseSruRecords(xml) {
  const ids = [];
  const titles = new Map();
  const types = new Map();

  // records can be <record> or <srw:record>
  const recordBlocks = xml.match(allTagBlocksRe("record")) || [];

  for (const rec of recordBlocks) {
    // identifier can be <dcterms:identifier> or sometimes <identifier>
    let id = null;

    const idm1 = rec.match(tagRe("identifier"));
    if (idm1) {
      const raw = (idm1[1] || "").replace(/\s+/g, " ").trim();
      // we only care about BWBRxxxx / BWBVxxxx tokens
      const m = raw.match(/\b(BWBR|BWBV)\d+\b/i);
      if (m) id = m[0].toUpperCase();
    }

    if (!id) continue;
    ids.push(id);

    // title: <dcterms:title> or <title>
    const tm = rec.match(tagRe("title"));
    if (tm) titles.set(id, (tm[1] || "").replace(/\s+/g, " ").trim());

    // type: <dcterms:type> or <type>
    const typm = rec.match(tagRe("type"));
    if (typm) types.set(id, (typm[1] || "").replace(/\s+/g, " ").trim());
  }

  // nextRecordPosition and numberOfRecords can be namespaced too
  let nextRecordPosition = null;
  let numberOfRecords = null;

  const nextm = xml.match(tagRe("nextRecordPosition"));
  if (nextm) {
    const n = parseInt((nextm[1] || "").trim(), 10);
    if (Number.isFinite(n)) nextRecordPosition = n;
  }

  const nom = xml.match(tagRe("numberOfRecords"));
  if (nom) {
    const n = parseInt((nom[1] || "").trim(), 10);
    if (Number.isFinite(n)) numberOfRecords = n;
  }

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
  if (!resp.ok) throw new Error(`Supabase upsert documents failed ${resp.status}: ${text.slice(0, 300)}`);
}

async function fetchXml(url, ms = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8" },
    });
    const text = await r.text();

    // Some SRU endpoints are odd with status codes; accept if it looks like SRU response.
    const looksLikeSru = /searchRetrieveResponse/i.test(text) || /searchRetrieveResponse/i.test(text);
    if (!r.ok && !looksLikeSru) return { ok: false, status: r.status, text };

    return { ok: true, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" });

    const startRecord = Math.max(1, safeInt(req.query.startRecord, 1));
    const maximumRecords = Math.min(50, Math.max(1, safeInt(req.query.maximumRecords, 25)));
    const includeVerdrag = toBool(req.query.include_verdrag);
    const doIngest = toBool(req.query.ingest);

    const limit = Math.min(60, Math.max(5, safeInt(req.query.limit, 60)));
    const offset = Math.max(0, safeInt(req.query.offset, 0));
    const maxCalls = Math.min(10, Math.max(1, safeInt(req.query.maxCalls, 6)));

    // Keep SRU query super simple and filter IDs client-side.
    const sruUrl =
      `https://zoekservice.overheid.nl/sru/Search` +
      `?operation=searchRetrieve` +
      `&version=1.2` +
      `&x-connection=BWB` +
      `&query=${encodeURIComponent("*")}` +
      `&startRecord=${startRecord}` +
      `&maximumRecords=${maximumRecords}`;

    const sruResp = await fetchXml(sruUrl, 25000);
    if (!sruResp.ok) {
      return res.status(500).json({
        error: "SRU fetch failed",
        status: sruResp.status,
        preview: sruResp.text.slice(0, 900),
      });
    }

    const parsed = parseSruRecords(sruResp.text);

    // Filter ids
    const ids = parsed.ids.filter(id => includeVerdrag ? /^(BWBR|BWBV)\d+/i.test(id) : /^BWBR\d+/i.test(id));

    // Upsert documents metadata so routing/filtering later is possible
    const docs = ids.map(id => ({
      id,
      title: parsed.titles.get(id) || id,
      type: parsed.types.get(id) || "BWB",
      source_url: `https://wetten.overheid.nl/${id}`,
    }));

    await supabaseUpsertDocuments({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, docs });

    // Optional: trigger ingest-bwb per id (bounded)
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
          `${baseUrl}/api/ingest-bwb?id=${encodeURIComponent(id)}` +
          `&limit=${limit}&offset=${offset}`;

        const rr = await fetchXml(ingestUrl, 25000);
        let json = null;
        try { json = JSON.parse(rr.text); } catch {}

        ingestResults.push({
          id,
          ok: !!(json && json.ok === true),
          status: rr.status,
          next: json?.next || null,
          preview: json || rr.text.slice(0, 200),
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
      batch: { count: ids.length, ids },
      ingest: doIngest ? { called: ingestResults.length, maxCalls, limit, offset, results: ingestResults } : { enabled: false },
      next: parsed.nextRecordPosition
        ? `/api/ingest-all?startRecord=${parsed.nextRecordPosition}&maximumRecords=${maximumRecords}&include_verdrag=${includeVerdrag ? 1 : 0}&ingest=${doIngest ? 1 : 0}&limit=${limit}&offset=${offset}&maxCalls=${maxCalls}`
        : null,
    });
  } catch (e) {
    return res.status(500).json({ error: "ingest-all crashed", details: String(e?.message || e) });
  }
};
