module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SERVICE_KEY missing" });

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify([{
        id: "TEST123",
        title: "test",
        source_url: "https://test.nl"
      }])
    });

    const text = await resp.text();

    return res.status(200).json({
      ok: resp.ok,
      supabase_url: SUPABASE_URL,
      response: text
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
