module.exports = async (req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "https://app.beleidsbank.nl");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const q = (req.query.q || "").toString().trim();

    if (!q) {
      return res.status(400).json({ error: "missing query" });
    }

    // -----------------------
    // EMBEDDING
    // -----------------------

    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: q
      })
    });

    const embJson = await embResp.json();

    if (!embJson?.data?.[0]?.embedding) {
      return res.status(500).json({
        ok:false,
        error:"embedding failed"
      });
    }

    const qvec = embJson.data[0].embedding;

    // -----------------------
    // DOCUMENT ROUTING
    // -----------------------

    const docResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      },
      body: JSON.stringify({
        query_embedding: qvec,
        match_count: 12
      })
    });

    const docRows = await docResp.json();

    let routedDocId = null;

if (docRows?.[0]?.similarity > 0.65) {
  routedDocId = docRows[0].id;
}

    // -----------------------
    // CHUNK SEARCH
    // -----------------------

    const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      },
      body: JSON.stringify({
        query_embedding: qvec,
        match_count: 12,
        doc_filter: routedDocId
      })
    });

    const rows = await rpcResp.json();
const results = Array.isArray(rows) ? rows : [];

const filtered = results;

    if (!filtered.length) {
      return res.status(200).json({
        ok:true,
        query:q,
        results:[],
        note:"Geen relevante wetgeving gevonden"
      });
    }

    return res.status(200).json({
      ok:true,
      query:q,
      routed_document: docRows?.[0] || null,
      results: filtered.map((r,i)=>({
        id:r.id,
        n:i+1,
        label:r.label,
        doc_id:r.doc_id,
        similarity:r.similarity,
        source_url:r.source_url,
        excerpt:(r.text||"").slice(0,1200)
      }))
    });

  }

  catch(e){

    return res.status(500).json({
      ok:false,
      error:"search crashed",
      details:String(e?.message || e)
    });

  }

};
