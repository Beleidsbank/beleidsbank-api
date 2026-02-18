// /api/source.js  (Vercel serverless function)
// GET /api/source?id=64

module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" });

    const id = (req.query.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "missing id" });

    const url =
      `${SUPABASE_URL}/rest/v1/chunks` +
      `?select=id,label,text,source_url,doc_id` +
      `&id=eq.${encodeURIComponent(id)}` +
      `&limit=1`;

    const r = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });

    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: "supabase failed", details: data });

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return res.status(404).json({ error: "not found" });

    return res.status(200).json({ ok: true, ...row });
  } catch (e) {
    return res.status(500).json({ error: "source crashed", details: String(e?.message || e) });
  }
};
