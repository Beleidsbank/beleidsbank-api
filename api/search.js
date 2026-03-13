// artikel detectie
const articleMatch = q.match(/artikel\s+([0-9:.]+)/i);

if (articleMatch) {

  const article = articleMatch[1];

  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/chunks?select=id,label,text,source_url,doc_id&label=ilike.*${article}*&limit=25`,
    { headers }
  );

  const rows = await resp.json();

  if (!Array.isArray(rows) || !rows.length) {
    return res.status(200).json({ ok:true, results:[] });
  }

  // unieke wetten bepalen
  const docs = [...new Set(rows.map(r => r.doc_id).filter(Boolean))];

  // meer dan 1 wet → vraag stellen
  if (docs.length > 1) {

    return res.status(200).json({
      ok:true,
      ambiguous:true,
      question:"Over welke wet gaat het? Bijvoorbeeld Awb, Omgevingswet of Bal.",
      options: rows.slice(0,5).map(r=>({
        title:r.label,
        doc_id:r.doc_id
      })),
      results:[]
    });

  }

  // slechts 1 wet → artikel tonen
  const results = rows.slice(0,5).map(r=>({
    id:r.id,
    label:r.label,
    text:r.text,
    excerpt:r.text,
    source_url:r.source_url,
    doc_id:r.doc_id
  }));

  return res.status(200).json({
    ok:true,
    results
  });

}
