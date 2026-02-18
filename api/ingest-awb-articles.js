module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    // limiet (handig voor V1 testen)
    const limit = Math.min(parseInt(req.query.limit || "120", 10) || 120, 300);

    // 1) download AWB XML
    const sourceXmlUrl = "https://wetten.overheid.nl/BWBR0005537/2024-01-01/0/tekst.xml";
    const xml = await fetch(sourceXmlUrl).then(r => r.text());

    // 2) heel simpele "artikel" parser op XML tags
    // We pakken blokken tussen <artikel ...> ... </artikel>
    const artikelen = xml.match(/<artikel\b[\s\S]*?<\/artikel>/gi) || [];

    if (!artikelen.length) {
      return res.status(500).json({ error: "Geen <artikel> blocks gevonden in XML" });
    }

    // helper: strip tags naar leesbare tekst
    const strip = (s) =>
      s
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();

    // helper: artikelnummer zoeken (werkt vaak)
    const getArtLabel = (artXml) => {
      // probeer eerst expliciete opschriften/nummering te vinden
      const m1 = artXml.match(/<kop[^>]*>[\s\S]*?<nr[^>]*>([\s\S]*?)<\/nr>[\s\S]*?<\/kop>/i);
      if (m1?.[1]) return strip(m1[1]);

      const m2 = artXml.match(/<nr[^>]*>([\s\S]*?)<\/nr>/i);
      if (m2?.[1]) return strip(m2[1]);

      return "Artikel (onbekend)";
    };

    // 3) document upsert (1x)
    await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify([{
        id: "BWBR0005537",
        title: "Algemene wet bestuursrecht",
        source_url: "https://wetten.overheid.nl/BWBR0005537"
      }]),
    });

    let saved = 0;
    const errors = [];

    // 4) per artikel: tekst + embedding + insert
    for (const artXml of artikelen.slice(0, limit)) {
      const label = getArtLabel(artXml);
      const text = strip(artXml);

      // skip heel korte stukjes
      if (!text || text.length < 120) continue;

      // embedding
      const embResp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text.slice(0, 6000),
        }),
      });

      const embJson = await embResp.json();
      if (!embResp.ok) {
        errors.push({ label, err: embJson });
        continue;
      }

      const embedding = embJson.data[0].embedding; // array of 1536

      // insert chunk
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/chunks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({
          doc_id: "BWBR0005537",
          label: `Awb — ${label}`,
          text,
          source_url: "https://wetten.overheid.nl/BWBR0005537",
          embedding
        }),
      });

      if (!ins.ok) {
        const t = await ins.text();
        errors.push({ label, err: t });
        continue;
      }

      saved++;
    }

    return res.status(200).json({
      ok: true,
      artikelen_found: artikelen.length,
      saved,
      limit_used: limit,
      errors_count: errors.length,
      errors: errors.slice(0, 3),
    });

  } catch (e) {
    return res.status(500).json({ crash: String(e?.message || e) });
  }
};
