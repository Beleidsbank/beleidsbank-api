// /api/ingest-test.js
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
    hasServiceKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
  });
};
