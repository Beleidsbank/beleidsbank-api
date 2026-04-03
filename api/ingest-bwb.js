module.exports = async (req, res) => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL) {
      return res.status(500).json({ error: "SUPABASE_URL missing" });
    }
    if (!SERVICE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_KEY missing" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing" });
    }

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
        .replace(/Druk het regelingonderdeel af/gi, "")
        .replace(/Sla het regelingonderdeel op/gi, "")
        .replace(/Vergelijk met andere versie/gi, "")
        .replace(/Geraadpleegd op .*? heden\./gi, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function htmlToText(html) {
      return (html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<\/(p|div|li|br|h1|h2|h3|h4|h5|h6|section|article|tr|td)>/gi, "\n")
        .replace(/<[^>]+>/g, "\n")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
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

    function splitArticles(text) {
      const re = /(^|\n)\s*(Artikel\s+[0-9]+(?:[.:][0-9]+)?[a-zA-Z]?)/g;
      const matches = [...text.matchAll(re)];
      const blocks = [];

      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index + (matches[i][1] ? matches[i][1].length : 0);
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        const block = text.slice(start, end).trim();

        if (!block || block.length < 80) continue;

        // paragrafen / hoofdstukken / titels wegfilteren
        const firstPart = block.slice(0, 250);
        if (/^§\s*\d+/i.test(firstPart)) continue;
        if (/Titel\s+\d+/i.test(firstPart) && !/^Artikel/i.test(firstPart)) continue;
        if (/Afdeling\s+\d+/i.test(firstPart) && !/^Artikel/i.test(firstPart)) continue;
        if (/Hoofdstuk\s+\d+/i.test(firstPart) && !/^Artikel/i.test(firstPart)) continue;

        blocks.push(block);
      }

      return blocks;
    }

    function getArticle(block, lawName) {
      const m = (block || "").match(/^Artikel\s+([0-9]+(?:[.:][0-9]+)?[a-zA-Z]?)/i);
      if (!m?.[1]) return "";

      let article = m[1].trim();

      // Awb gebruikt dubbele punt
      if (lawName === "Awb" && /^\d+\.\d+[a-zA-Z]?$/.test(article)) {
        article = article.replace(".", ":");
      }

      return article;
    }

    const htmlResp = await fetch(sourceUrl);
    const html = await htmlResp.text();

    if (!htmlResp.ok) {
      return res.status(500).json({
        error: "wetten.overheid fetch failed",
        details: html.slice(0, 400)
      });
    }

    const plain = htmlToText(html);
    const allArticles = splitArticles(plain);

    if (!allArticles.length) {
      return res.status(500).json({ error: "geen artikelen gevonden" });
    }

    const lawName = getLawName(id);
    const batch = allArticles.slice(offset, offset + limit);

    if (!batch.length) {
      return res.status(200).json({
        ok: true,
        processed: 0,
        done: true
      });
    }

    const docResp = await fetch(`${SUPABASE_URL}/rest/v1/documents?on_conflict=id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify([{
        id,
        title: lawName,
        source_url: sourceUrl
      }])
    });

    const docText = await docResp.text();
    if (!docResp.ok) {
      return res.status(500).json({
        error: "documents insert failed",
        details: docText
      });
    }

    const prepared = batch
      .map(raw => {
        const text = cleanText(raw);
        const article = getArticle(text, lawName);
        if (!text || !article) return null;

        return {
          text: text.slice(0, 8000),
          article
        };
      })
      .filter(Boolean);

    if (!prepared.length) {
      return res.status(200).json({
        ok: true,
        processed: 0,
        next: `/api/ingest-bwb?id=${id}&offset=${offset + limit}`
      });
    }

    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: prepared.map(x => x.text)
      })
    });

    const embText = await embResp.text();
    if (!embResp.ok) {
      return res.status(500).json({
        error: "embedding failed",
        details: embText
      });
    }

    const embJson = JSON.parse(embText);
    const embeddings = embJson.data.map(d => d.embedding);

    const rows = prepared.map((item, i) => ({
      doc_id: id,
      law_name: lawName,
      article_number: item.article,
      label: `${lawName} — Artikel ${item.article}`,
      text: item.text,
      source_url: sourceUrl,
      embedding: embeddings[i]
    }));

    const chunkResp = await fetch(`${SUPABASE_URL}/rest/v1/chunks?on_conflict=doc_id,label`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(rows)
    });

    const chunkText = await chunkResp.text();
    if (!chunkResp.ok) {
      return res.status(500).json({
        error: "chunk insert failed",
        details: chunkText
      });
    }

    return res.status(200).json({
      ok: true,
      law: lawName,
      total_found: allArticles.length,
      processed: rows.length,
      next: `/api/ingest-bwb?id=${id}&offset=${offset + limit}`
    });
  } catch (e) {
    return res.status(500).json({
      error: "ingest-bwb crashed",
      details: String(e?.message || e)
    });
  }
};
