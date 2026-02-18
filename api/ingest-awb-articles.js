module.exports = async (req, res) => {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const limit = Math.min(parseInt(req.query.limit || "120", 10) || 120, 300);

    // download XML
    const xml = await fetch(
      "https://wetten.overheid.nl/BWBR0005537/2024-01-01/0/tekst.xml"
    ).then(r => r.text());

    // FIX: case-insensitive + namespace-safe artikel matcher
    const artikelen =
      xml.match(/<[^>]*[Aa]rtikel\b[\s\S]*?<\/[^>]*[Aa]rtikel>/g) || [];

    if (!artikelen.length) {
      return res.status(500).json({
        error: "Nog steeds geen artikelen gevonden",
        hint: "XML structuur onverwacht"
      });
    }

    const strip = (s) =>
      s.replace(/<[^>]+>/g, " ")
       .replace(/&nbsp;/g, " ")
       .replace(/&amp;/g, "&")
       .replace(/\s+/g, " ")
       .trim();

    const getNr = (s) => {
      const m = s.match(/<nr[^>]*>(.*?)<\/nr>/i);
      if (m?.[1]) return strip(m[1]);
      return "Artikel";
    };

    // document upsert
    await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        apikey:SERVICE_KEY,
        Authorization:`Bearer ${SERVICE_KEY}`,
        Prefer:"resolution=merge-duplicates"
      },
      body:JSON.stringify([{
        id:"BWBR0005537",
        title:"Algemene wet bestuursrecht",
        source_url:"https://wetten.overheid.nl/BWBR0005537"
      }])
    });

    let saved = 0;

    for (const art of artikelen.slice(0,limit)) {

      const label = getNr(art);
      const text = strip(art);

      if (!text || text.length < 150) continue;

      // embedding
      const emb = await fetch("https://api.openai.com/v1/embeddings",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          Authorization:`Bearer ${OPENAI_KEY}`
        },
        body:JSON.stringify({
          model:"text-embedding-3-small",
          input:text.slice(0,6000)
        })
      }).then(r=>r.json());

      const embedding = emb.data[0].embedding;

      // insert
      await fetch(`${SUPABASE_URL}/rest/v1/chunks`,{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          apikey:SERVICE_KEY,
          Authorization:`Bearer ${SERVICE_KEY}`
        },
        body:JSON.stringify({
          doc_id:"BWBR0005537",
          label:`Awb — ${label}`,
          text,
          source_url:"https://wetten.overheid.nl/BWBR0005537",
          embedding
        })
      });

      saved++;
    }

    res.json({
      ok:true,
      artikelen_found:artikelen.length,
      saved
    });

  } catch(e){
    res.status(500).json({ crash:String(e) });
  }
};
