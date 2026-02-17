// /api/ingest-test.js
// Test: kan ik Supabase bereiken + 1 rij uit documents lezen?

module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const SUPABASE_URL = "https://irgqihvzqdszreblajcs.supabase.co";


    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" });

    const url = `${SUPABASE_URL}/rest/v1/documents?select=id,title&limit=1`;

    const r = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });

    const text = await r.text();
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(500).json({ crash: String(e?.message || e) });
  }
};
