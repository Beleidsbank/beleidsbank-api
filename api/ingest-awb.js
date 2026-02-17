module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    // download Awb XML
    const xml = await fetch(
      "https://wetten.overheid.nl/BWBR0005537/2024-01-01/0/tekst.xml"
    ).then(r => r.text());

    // pak alleen tekst (simpel voor V1)
    const plain = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    // split in stukken van 1200 chars
    const chunks = [];
    for (let i = 0; i < plain.length; i += 1200) {
      chunks.push(plain.slice(i, i + 1200));
    }

    let saved = 0;

    for (const text of chunks.slice(0, 40)) {   // eerste 40 stukken voor test

      // embedding
      const emb = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
        }),
      }).then(r => r.json());

      const embedding = JSON.stringify(emb.data[0].embedding);

      // insert chunk
      await fetch(`${SUPABASE_URL}/rest/v1/chunks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({
          doc_id: "BWBR0005537",
          label: "AWB",
          text,
          source_url: "https://wetten.overheid.nl/BWBR0005537",
          embedding
        })
      });

      saved++;
    }

    res.json({ ok:true, chunks_saved:saved });

  } catch(e) {
    res.status(500).json({ crash:String(e) });
  }
};
