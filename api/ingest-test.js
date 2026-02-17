import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

export default async function handler(req, res) {

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {

    const url = "https://wetten.overheid.nl/BWBR0005537/2024-01-01/0/tekst.xml";

    const xml = await fetch(url).then(r => r.text());

    const text = xml.slice(0, 2000);

    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });

    await supabase.from("documents").upsert({
      id: "BWBR0005537",
      title: "Algemene wet bestuursrecht",
      source_url: url,
    });

    await supabase.from("chunks").insert({
      doc_id: "BWBR0005537",
      label: "TEST",
      text,
      source_url: url,
      embedding: emb.data[0].embedding,
    });

    res.status(200).json({ ok: true });

  } catch (e) {

    res.status(500).json({ error: String(e) });

  }
}
