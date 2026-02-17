// /api/ingest-test.js
module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    // 1) download 1 landelijke wet (test)
    const sourceUrl = "https://wetten.overheid.nl/BWBR0005537/2024-01-01/0/tekst.xml";
    const xml = await fetch(sourceUrl).then(r => r.text());
    const text = xml.slice(0, 2000);

    // 2) embedding maken
    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
      }),
    });
    const embJson = await embResp.json();
    if (!embResp.ok) return res.status(500).json({ error: "OpenAI embedding failed", details: embJson });

    const embedding = embJson.data[0].embedding;

    // helper: postgrest upsert/insert
    async function upsert(table, rows) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(rows),
      });
      const t = await r.text();
      return { status: r.status, text: t };
    }

    // 3) document upsert
    const doc = await upsert("documents", [{
      id: "BWBR0005537",
      title: "Algemene wet bestuursrecht",
      source_url: sourceUrl
    }]);

    if (doc.status >= 300) return res.status(500).json({ error: "Supabase documents upsert failed", details: doc });

    // 4) chunk insert (1 test chunk)
    const chunk = await upsert("chunks", [{
      doc_id: "BWBR0005537",
      label: "TEST",
      text,
      source_url: sourceUrl,
      embedding
    }]);

    if (chunk.status >= 300) return res.status(500).json({ error: "Supabase chunks insert failed", details: chunk });

    return res.status(200).json({ ok: true, saved: { document: doc.text, chunk: chunk.text } });

  } catch (e) {
    return res.status(500).json({ crash: String(e?.message || e) });
  }
};
