// beleidsbank-api/api/ingest-all.js
// Stap 1: haal BWBR IDs uit SRU (BWB) en (optioneel) trigger ingest-bwb.
// Compatibel met jouw Supabase schema: documents(id, title, source_url) -> GEEN 'type'.

function safeInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function toBool(v) {
  const s = (v ?? "").toString().toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes";
}
function uniq(arr) { return [...new Set(arr)]; }

function allTagBlocksRe(tag) {
  return new RegExp(`<\\s*(?:[a-z0-9_-]+:)?${tag}\\b[\\s\\S]*?<\\s*\\/\\s*(?:[a-z0-9_-]+:)?${tag}\\s*>`, "gi");
}
function firstTagValue(xml, tag) {
  const re = new RegExp(
    `<\\s*(?:[a-z0-9_-]+:)?${tag}\\b[^>]*>\\s*([\\s\\S]*?)\\s*<\\s*\\/\\s*(?:[a-z0-9_-]+:)?${tag}\\s*>`,
    "i"
  );
  const m = xml.match(re);
  return m ? m[1] : null;
}

function parseSruRecords(xml) {
  const ids = [];
  const titles = new Map();

  const recordBlocks = xml.match(allTagBlocksRe("record")) || [];

  for (const rec of recordBlocks) {
    const identRaw = firstTagValue(rec, "identifier");
    if (identRaw) {
      const m = identRaw.match(/\b(BWBR|BWBV)\d+\b/i);
      if (m) ids.push(m[0].toUpperCase());
    }

    const t = firstTagValue(rec, "title");
    if (t && ids.length) titles.set(ids[ids.length - 1], t.replace(/\s+/g, " ").trim());
  }

  // fallback: scan hele XML
  if (!ids.length) {
    const m = xml.match(/\bBWBR\d+\b/gi) || [];
    ids.push(...m.map(x => x.toUpperCase()));
  }

  const numberOfRecordsRaw = firstTagValue(xml, "numberOfRecords");
  const nextRecordPositionRaw = firstTagValue(xml, "nextRecordPosition");

  const numberOfRecords = numberOfRecordsRaw ? safeInt(numberOfRecordsRaw.trim(), null) : null;
  const nextRecordPosition = nextRecordPositionRaw ? safeInt(nextRecordPositionRaw.trim(), null) : null;

  return { ids: uniq(ids), titles, numberOfRecords, nextRecordPosition };
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

async function fetchText(url, ms = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8" },
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
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
    const maxCalls = Math.min(10, Math.max(1, safeInt(req.query.maxCalls, 2)));

    // Correcte SRU "alles" query + accept param
    const sruUrl =
      `https://zoekservice.overheid.nl/sru/Search` +
      `?operation=searchRetrieve` +
      `&version=1.2` +
      `&x-connection=BWB` +
      `&x-info-1-accept=any` +
      `&query=${encodeURIComponent("cql.allRecords=1")}` +
      `&startRecord=${startRecord}` +
      `&maximumRecords=${maximumRecords}`;

    const sruResp = await fetchText(sruUrl, 25000);
    if (!sruResp.ok) {
      return res.status(500).json({
        error: "SRU fetch failed",
        status: sruResp.status,
        preview: sruResp.text.slice(0, 1200),
      });
    }

    const parsed = parseSruRecords(sruResp.text);

    // BWBR = regelingen, BWBV = verdragen
    const ids = parsed.ids
      .filter(id => includeVerdrag ? /^(BWBR|BWBV)\d+/i.test(id) : /^BWBR\d+/i.test(id))
      .slice(0, maximumRecords);

    // ✅ Alleen kolommen die jij hebt
    const docs = ids.map(id => ({
      id,
      title: parsed.titles.get(id) || id,
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

        const rr = await fetchText(ingestUrl, 25000);
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
