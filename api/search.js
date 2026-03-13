module.exports = async (req, res) => {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({
        ok:false,
        error:"Missing Supabase env",
        results:[]
      });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    };

    let q = (req.query.q || "").toString().trim().toLowerCase();

    if (!q) {
      return res.json({ ok:true, results:[] });
    }

    const DOCS = {
      awb: "BWBR0005537",
      omgevingswet: "BWBR0037885"
    };

    function cleanText(s) {
      return (s || "")
        .replace(/\s+/g," ")
        .trim();
    }

    function extractTokens(input) {

      const stop = new Set([
        "wat","is","een","de","het","van","in","op","om","te","met",
        "voor","bij","en","of","aan","tot","dan","dit","dat",
        "wanneer","hoe","waar","waarom","welke","wie",
        "artikel","awb","omgevingswet"
      ]);

      return input
        .replace(/[?.,;:()]/g," ")
        .split(/\s+/)
        .map(x=>x.trim())
        .filter(Boolean)
        .filter(x=>x.length >= 3)
        .filter(x=>!stop.has(x));
    }

    async function fetchJson(url) {

      const r = await fetch(url,{ headers });
      const text = await r.text();

      let json = null;

      try { json = JSON.parse(text); } catch {}

      if (!Array.isArray(json)) return [];

      return json;
    }

    async function queryChunks({docId=null,textLike=null,labelLike=null,limit=10}) {

      let url =
        `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&limit=${limit}`;

      if (docId) {
        url += `&doc_id=eq.${docId}`;
      }

      if (textLike) {
        url += `&text=ilike.*${encodeURIComponent(textLike)}*`;
      }

      if (labelLike) {
        url += `&label=ilike.*${encodeURIComponent(labelLike)}*`;
      }

      return await fetchJson(url);

    }

    function detectLaw(input) {

      if (input.includes("awb") || input.includes("algemene wet bestuursrecht"))
        return DOCS.awb;

      if (input.includes("omgevingswet"))
        return DOCS.omgevingswet;

      return null;

    }

    function normalizeArticleVariants(a) {

      const v = new Set([a]);

      if (a.includes(".") && !a.includes(":"))
        v.add(a.replace(/\./g,":"));

      if (a.includes(":") && !a.includes("."))
        v.add(a.replace(/:/g,"."));

      return [...v];

    }

    function rank(rows, keyword, preferredDoc) {

      return rows
        .map(r => {

          let score = 0;

          const label = (r.label || "").toLowerCase();
          const text = cleanText(r.text).toLowerCase();

          if (preferredDoc && r.doc_id === preferredDoc)
            score += 50;

          if (keyword && text.includes(keyword))
            score += 20;

          if (keyword && label.includes(keyword))
            score += 10;

          if (text.includes("wordt verstaan"))
            score += 20;

          if (text.includes("schriftelijke beslissing"))
            score += 20;

          return { ...r, score };

        })
        .sort((a,b)=>b.score-a.score);

    }

    // -------------------------
    // Exact artikel lookup
    // -------------------------

    const articleMatch = q.match(/artikel\s+([0-9a-z:.]+)/i);
    const lawId = detectLaw(q);

    if (articleMatch) {

      const article = articleMatch[1]
  .replace(/\./g,":")
  .trim();
      const variants = normalizeArticleVariants(article);

      let rows = [];

      for (const v of variants) {

        rows.push(...await queryChunks({
          docId: lawId,
          labelLike:`artikel ${v}`,
          limit:10
        }));

      }

      if (rows.length) {

        return res.json({
          ok:true,
          results: rows.slice(0,8)
        });

      }

    }

    // -------------------------
    // Keyword search
    // -------------------------

    const tokens = extractTokens(q);

    const primaryToken = tokens[0] || "";
    const secondaryToken = tokens[1] || "";

    let rows = [];

    rows.push(...await queryChunks({
      docId: DOCS.awb,
      textLike: primaryToken,
      limit:10
    }));

    if (secondaryToken) {

      rows.push(...await queryChunks({
        docId: DOCS.awb,
        textLike: secondaryToken,
        limit:10
      }));

    }

    rows.push(...await queryChunks({
      docId: DOCS.omgevingswet,
      textLike: primaryToken,
      limit:10
    }));

    if (rows.length < 10) {

      rows.push(...await queryChunks({
        textLike: primaryToken,
        limit:20
      }));

    }

    const ranked = rank(rows, primaryToken, detectLaw(q));

    return res.json({
      ok:true,
      results: ranked.slice(0,15).map(r=>({
        id:r.id,
        label:r.label,
        text:cleanText(r.text),
        excerpt:cleanText(r.text),
        source_url:r.source_url,
        doc_id:r.doc_id
      }))
    });

  }

  catch(e) {

    return res.status(500).json({
      ok:false,
      error:String(e),
      results:[]
    });

  }

};
