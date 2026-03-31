module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify([{
        doc_id: "BWBR0005537",
        law_name: "Awb",
        article_number: "1:3",
        label: "Awb — Artikel 1:3",
        text: "Artikel 1:3 testtekst",
        source_url: "https://wetten.overheid.nl/BWBR0005537"
      }])
    });

    const text = await resp.text();

    return res.status(200).json({
      ok: resp.ok,
      response: text
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
