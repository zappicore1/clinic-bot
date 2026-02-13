import axios from "axios";

const GRAPH = "https://graph.facebook.com/v19.0";

export function handleWebhookVerification(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

export async function handleIncomingMessage(body) {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  const msg = value?.messages?.[0];
  if (!msg) return;

  const from = msg.from;
  const text = (msg?.text?.body || "").trim();
  const t = text.toLowerCase();

  if (t === "hola" || t === "buenas") {
    return sendText(
      from,
      `¡Hola! 👋 Soy Clinic Bot.\n\n` +
      `Escribe:\n` +
      `1️⃣ Cita\n` +
      `2️⃣ Precios\n` +
      `3️⃣ Horario`
    );
  }

  if (t === "1" || t.includes("cita")) {
    return sendText(
      from,
      `📅 Para pedir cita dime:\n` +
      `Especialidad + día + hora\n\n` +
      `Ejemplo: "Dental lunes tarde"`
    );
  }

  if (t === "2" || t.includes("precio")) {
    return sendText(
      from,
      `💶 Precios:\n` +
      `Consulta: 30€\nRevisión: 20€`
    );
  }

  if (t === "3" || t.includes("horario")) {
    return sendText(
      from,
      `🕒 Horario:\n` +
      `L–V 9–14 / 16–20`
    );
  }

  return sendText(
    from,
    `No te he entendido 😅\nEscribe *hola* para empezar.`
  );
}


async function sendText(to, text) {
  const url = `${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}
