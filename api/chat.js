export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message } = req.body;

  res.status(200).json({
    answer: "Je stuurde deze vraag: " + message
  });
}
