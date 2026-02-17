// /api/ingest-test.js
module.exports = (req, res) => {
  res.status(200).json({ ok: true, msg: "ingest-test is alive" });
};
