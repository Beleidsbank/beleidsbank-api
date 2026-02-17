import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url) {
      return res.status(500).json({ error: "SUPABASE_URL missing" });
    }

    if (!key) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY missing" });
    }

    const supabase = createClient(url, key);

    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .limit(1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      ok: true,
      foundRows: data.length
    });

  } catch (e) {
    return res.status(500).json({
      crash: String(e.message || e)
    });
  }
}
