module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const limit = Math.min(parseInt(req.query.limit || "80", 10) || 80, 200);

    // 1) download XML
    const xmlUrl = "https://wetten.overheid.nl/BWBR0005537/2024-01-01/0/tekst.xml";
    const xml = await fetch(xmlUrl).then(r => r.text());

    // 2) maak leesbare tekst (met newlines op logische plekken)
    let text = xml
      .replace(/<(br|BR)\s*\/?>/g, "\n")
      .replace(/<\/(p|P|div|DIV|tr|TR|td|TD|li|LI|kop|Kop|titel|Titel|hoofdstuk|Hoofdstuk|afdeling|Afdeling|paragraaf|Paragraaf|lid|Lid)>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // 3) split op "Artikel X:Y" (Awb gebruikt deze nummering)
    const re = /\bArtikel\s+(\d+:\d+)\b/g;
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ idx: m.index, nr: m[1] });
    }

    if (matches.length < 3) {
      return res.status(500).json({
        error: "Kon geen artikelkoppen vinden in platte tekst",
        matches_found: matches.length,
        hint: "Controleer of de XML-tekst de string 'Artikel 1:3' bevat."
      });
    }

    // document upsert
    await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify([{
        id: "BWBR0005537",
        title: "Algemene wet bestuursrecht",
        source_url: "https://wetten.overheid.nl/BWBR0005537"
      }])
    });

    let saved = 0;

    // maak artikelblokken
    const blocks = [];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].idx;
      const end = (i + 1 < matches.length) ? matches[i + 1].idx : text.length;
      const nr = matches[i].nr;

      const block = text.slice(start, end).trim();
      if (block.length < 200) continue;

      blocks.push({ nr, block });
      if (blocks.length >= limit) break;
    }

    // 4) per artikel: embedding + insert
    for (const b of blocks) {
      const embResp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: b.block.slice(0, 6000)
        })
      });

      const embJson = await embResp.json();
      if (!embResp.ok) continue;

      const embedding = embJson.data[0].embedding;

      const ins = await fetch(`${SUPABASE_URL}/rest/v1/chunks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`
        },
        body: JSON.stringify({
          doc_id: "BWBR0005537",
          label: `Awb — Artikel ${b.nr}`,
          text: b.block,
          source_url: "https://wetten.overheid.nl/BWBR0005537",
          embedding
        })
      });

      if (ins.ok) saved++;
    }

    return res.json({
      ok: true,
      article_heads_found: matches.length,
      blocks_prepared: blocks.length,
      saved
    });

  } catch (e) {
    return res.status(500).json({ crash: String(e?.message || e) });
  }
};
