module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // delete alle chunks van deze wet
    const del = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?doc_id=eq.BWBR0005537`,
      {
        method: "DELETE",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      }
    );

    const text = await del.text();
    return res.status(200).json({ ok: true, deleted: text || "done" });
  } catch (e) {
    return res.status(500).json({ crash: String(e?.message || e) });
  }
};
