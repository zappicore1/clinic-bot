import axios from "axios";
import { getSession, resetSession } from "./state.js";

const GRAPH = "https://graph.facebook.com/v24.0";
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL;
//No se q es esta mierda
export function handleWebhookVerification(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

/* ================= INCOMING ================= */
export async function handleIncomingMessage(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const from = msg.from;
  const text = (msg.text?.body || "").trim();
  const t = text.toLowerCase();

  if (t === "hola") {
    resetSession(from);
    return sendText(from, `Hola 👋 Escribe *cita* para pedir cita`);
  }

  const s = getSession(from);

  if (t.includes("cita") && s.step === "IDLE") {
    s.step = "ASK_SPECIALTY";
    s.data = {};
    return sendText(from, `¿Para qué especialidad?`);
  }

  if (s.step === "ASK_SPECIALTY") {
    s.data.specialty = text;

    const r = await axios.post(SHEET_WEBHOOK_URL, { action: "suggest" });
    if (!r.data?.ok) return sendText(from, `No hay días disponibles 😕`);

    s.data.days = r.data.days;
    s.step = "ASK_DAY";

    let msg = "Tengo estos días libres:\n";
    r.data.days.forEach((d,i)=> msg += `${i+1}️⃣ ${d}\n`);
    msg += "\nResponde 1, 2 o 3";

    return sendText(from, msg);
  }

  if (s.step === "ASK_DAY") {
    const idx = Number(t) - 1;
    const day = s.data.days[idx];
    if (!day) return sendText(from, `Elige 1, 2 o 3`);

    s.data.day = day;
    s.step = "ASK_TIME";
    return sendText(from, `¿Hora o franja? (mañana / tarde / 17:30)`);
  }

  if (s.step === "ASK_TIME") {
    s.data.time = text;
    s.step = "ASK_NAME";
    return sendText(from, `¿Tu nombre completo?`);
  }

  if (s.step === "ASK_NAME") {
    s.data.name = text;

    await axios.post(SHEET_WEBHOOK_URL, {
      telefono: from,
      nombre: s.data.name,
      especialidad: s.data.specialty,
      dia: s.data.day,
      hora: s.data.time,
      estado: "pendiente"
    });

    resetSession(from);
    return sendText(from, `✅ Solicitud enviada. Recepción te confirmará.`);
  }
}

/* ================= SEND ================= */
async function sendText(to, text) {
  await axios.post(
    `${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body: text }},
    { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }}
  );
}
