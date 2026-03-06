module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ ok: false, error: "missing query" });

    // Gebruik Postgres full-text search (snel en geschikt voor wetstekst)
    const url =
      `${SUPABASE_URL}/rest/v1/chunks` +
      `?select=id,label,text,source_url` +
      `&text=fts.${encodeURIComponent(q)}` +
      `&limit=8`;

    const resp = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });

    const rows = await resp.json();

    const results = (Array.isArray(rows) ? rows : []).map((r) => ({
      id: r.id,
      label: r.label,
      text: r.text,
      excerpt: r.text,
      source_url: r.source_url,
    }));

    return res.json({ ok: true, results });
  } catch (e) {
    return res.json({ ok: false, error: String(e) });
  }
};
