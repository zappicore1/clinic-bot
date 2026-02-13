import axios from "axios";
import { getSession, resetSession } from "./state.js";

const GRAPH = "https://graph.facebook.com/v24.0";
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

/* ================= WEBHOOK VERIFY ================= */
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
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const msg = value?.messages?.[0];
  if (!msg) return;

  const from = msg.from;
  const text = (msg?.text?.body || "").trim();
  const t = text.toLowerCase();

  // comandos globales
  if (t === "hola" || t === "menu" || t === "menú") {
    resetSession(from);
    return sendText(
      from,
      `¡Hola! 👋 Soy Clinic Bot.\n\n` +
      `1️⃣ Pedir cita\n` +
      `2️⃣ Precios\n` +
      `3️⃣ Horario`
    );
  }

  if (t === "cancelar") {
    resetSession(from);
    return sendText(from, `Proceso cancelado ❌ Escribe *hola* para empezar.`);
  }

  const s = getSession(from);

  if (s.step !== "IDLE") {
    return handleBookingFlow({ from, text, t, s });
  }

  if (t === "1" || t.includes("cita")) {
    s.step = "ASK_SPECIALTY";
    s.data = {};
    return sendText(from, `¿Para qué especialidad? (ej: dental, fisio)`);
  }

  if (t === "2") {
    return sendText(from, `💶 Precios orientativos:\nConsulta 30€\nRevisión 20€`);
  }

  if (t === "3") {
    return sendText(from, `🕒 Horario:\nL–V 9–14 y 16–20\nS 10–13`);
  }

  return sendText(from, `No te he entendido 😅 Escribe *hola*`);
}

/* ================= BOOKING FLOW (MODO B) ================= */
async function handleBookingFlow({ from, text, t, s }) {

  // 1️⃣ Especialidad
  if (s.step === "ASK_SPECIALTY") {
    s.data.specialty = text;
    s.step = "ASK_DAY";
    return sendText(from, `Perfecto ✅ ¿Qué día te viene bien? (lunes / mañana / 12-03)`);
  }

  // 2️⃣ Día → pedir huecos al Calendar
  if (s.step === "ASK_DAY") {
    s.data.dayText = text;

    let r;
    try {
      r = await axios.post(APPS_SCRIPT_URL, {
        action: "suggest",
        phone: from,
        specialty: s.data.specialty,
        dayText: s.data.dayText
      });
    } catch (e) {
      return sendText(from, `Error consultando agenda 😕 Prueba otro día.`);
    }

    if (!r.data?.ok || r.data.slots.length === 0) {
      return sendText(from, `No hay huecos ese día 😕 Dime otro.`);
    }

    s.data.slots = r.data.slots;
    s.step = "ASK_SLOT";

    let msg = "Huecos disponibles:\n";
    r.data.slots.forEach((x, i) => {
      msg += `${i + 1}️⃣ ${x.label}\n`;
    });
    msg += `\nResponde 1, 2 o 3`;

    return sendText(from, msg);
  }

  // 3️⃣ Elegir hueco
  if (s.step === "ASK_SLOT") {
    const idx = Number(t) - 1;
    if (isNaN(idx) || !s.data.slots[idx]) {
      return sendText(from, `Elige 1, 2 o 3`);
    }

    s.data.slot = s.data.slots[idx];
    s.step = "ASK_NAME";
    return sendText(from, `Genial 👍 dime tu nombre y apellido`);
  }

  // 4️⃣ Nombre
  if (s.step === "ASK_NAME") {
    s.data.name = text;
    s.step = "CONFIRM";
    return sendText(
      from,
      `Confirma tu cita:\n` +
      `🩺 ${s.data.specialty}\n` +
      `📅 ${s.data.slot.label}\n` +
      `👤 ${s.data.name}\n\n` +
      `Responde *SI* para confirmar`
    );
  }

  // 5️⃣ Confirmar → Calendar + Sheets + Email
  if (s.step === "CONFIRM") {
    if (t !== "si" && t !== "sí") {
      resetSession(from);
      return sendText(from, `Cancelado ❌ Escribe *hola*`);
    }

    let r;
    try {
      r = await axios.post(APPS_SCRIPT_URL, {
        action: "book",
        phone: from,
        name: s.data.name,
        specialty: s.data.specialty,
        dayText: s.data.dayText,
        slotStartISO: s.data.slot.startISO
      });
    } catch (e) {
      resetSession(from);
      return sendText(from, `Error reservando 😕 Intenta otra vez.`);
    }

    resetSession(from);
    return sendText(
      from,
      `✅ Cita confirmada\n` +
      `📅 ${r.data.label}\n` +
      `👤 ${s.data.name}\n\n` +
      `¡Te esperamos!`
    );
  }

  resetSession(from);
  return sendText(from, `Proceso reiniciado. Escribe *hola*`);
}

/* ================= SEND TEXT ================= */
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
