module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL missing" });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY missing" });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const id = (req.query.id || "").toString().trim();
    if (!/^BWBR/i.test(id)) {
      return res.status(400).json({ error: "Use ?id=BWBR..." });
    }

    const limit = 40;
    const offset = parseInt(req.query.offset || "0", 10);
    const sourceUrl = `https://wetten.overheid.nl/${id}`;

    function cleanText(t) {
      return (t || "")
        .replace(/Toon relaties in LiDO/gi, "")
        .replace(/Maak een permanente link/gi, "")
        .replace(/Toon wetstechnische informatie/gi, "")
        .replace(/\.\.\./g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function htmlToText(html) {
      return (html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6)>/gi, "\n")
        .replace(/<[^>]+>/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function splitArticles(text) {
      const re = /Artikel\s+\d+[a-zA-Z]?(?::\d+[a-zA-Z]?)?/g;
      const matches = [...text.matchAll(re)];
      const blocks = [];

      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        const block = text.slice(start, end).trim();
        if (block.length > 100) blocks.push(block);
      }

      return blocks;
    }

    function getLawName(id) {
      const map = {
        "BWBR0005537": "Awb",
        "BWBR0037885": "Omgevingswet",
        "BWBR0041330": "Bal",
        "BWBR0041297": "Bbl",
        "BWBR0041313": "Bkl",
        "BWBR0041298": "Wkb"
      };
      return map[id] || id;
    }

    function getArticle(block) {
      const m = block.match(/^Artikel\s+([0-9A-Za-z:.\-]+)/);
      return m?.[1] || "";
    }

    const htmlResp = await fetch(sourceUrl);
    const html = await htmlResp.text();

    if (!htmlResp.ok) {
      return res.status(500).json({ error: "wetten.overheid fetch failed", details: html.slice(0, 300) });
    }

    const plain = htmlToText(html);
    const articles = splitArticles(plain);

    if (!articles.length) {
      return res.status(500).json({ error: "geen artikelen gevonden" });
    }

    const batch = articles.slice(offset, offset + limit);
    const lawName = getLawName(id);

    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: batch
      })
    });

    const embText = await embResp.text();
    if (!embResp.ok) {
      return res.status(500).json({ error: "embedding failed", details: embText.slice(0, 500) });
    }

    const embJson = JSON.parse(embText);
    const embeddings = embJson.data.map(d => d.embedding);

    const docResp = await fetch(`${SUPABASE_URL}/rest/v1/documents?on_conflict=id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify([{
        id,
        title: lawName,
        source_url: sourceUrl
      }])
    });

    const docText = await docResp.text();
    if (!docResp.ok) {
      return res.status(500).json({ error: "documents insert failed", details: docText.slice(0, 500) });
    }

    for (let i = 0; i < batch.length; i++) {
      const raw = batch[i];
      const text = cleanText(raw);
      const article = getArticle(text);

      const chunkResp = await fetch(`${SUPABASE_URL}/rest/v1/chunks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          doc_id: id,
          law_name: lawName,
          article_number: article,
          label: `${lawName} — Artikel ${article}`,
          text,
          source_url: sourceUrl,
          embedding: embeddings[i]
        })
      });

      const chunkText = await chunkResp.text();
      if (!chunkResp.ok) {
        return res.status(500).json({
          error: "chunk insert failed",
          article,
          details: chunkText.slice(0, 500)
        });
      }
    }

    return res.json({
      ok: true,
      total_articles: articles.length,
      processed: batch.length,
      next: `/api/ingest-bwb?id=${id}&offset=${offset + limit}`
    });

  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
