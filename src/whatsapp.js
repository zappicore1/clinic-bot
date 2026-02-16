import axios from "axios";
import { getSession, resetSession } from "./state.js";

const GRAPH = "https://graph.facebook.com/v24.0";
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL;

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
        `Escribe:\n` +
        `1️⃣ Pedir cita\n` +
        `2️⃣ Precios\n` +
        `3️⃣ Horario\n\n` +
        `En cualquier momento: *cancelar*`
    );
  }

  if (t === "cancelar" || t === "reiniciar") {
    resetSession(from);
    return sendText(from, `Proceso cancelado ✅ Escribe *hola* para empezar.`);
  }

  const s = getSession(from);

  // Si está en proceso de reserva, seguimos el wizard
  if (s.step !== "IDLE") {
    return handleBookingFlow({ from, text, t, s });
  }

  // Menú
  if (t === "1" || t.includes("cita") || t.includes("reserv")) {
    s.step = "ASK_SPECIALTY";
    s.data = {};
    return sendText(from, `Perfecto 📅 ¿Para qué especialidad? (Ej: dental, fisio, estética)`);
  }

  if (t === "2" || t.includes("precio")) {
    return sendText(from, `💶 Precios orientativos:\n- Consulta: 30€\n- Revisión: 20€\n\nEscribe *hola* para menú.`);
  }

  if (t === "3" || t.includes("horario")) {
    return sendText(from, `🕒 Horario:\nL–V 9:00–14:00 y 16:00–20:00\nS 10:00–13:00\n\nEscribe *hola* para menú.`);
  }

  return sendText(from, `No te he entendido 😅 Escribe *hola* para ver el menú.`);
}

/* ================= BOOKING FLOW (SOLO SHEETS) ================= */
async function handleBookingFlow({ from, text, t, s }) {
  // Paso 1: especialidad
  if (s.step === "ASK_SPECIALTY") {
    s.data.specialty = text;
    s.data.days = nextBusinessDaysLabels(3); // ["mar 20/02", "mié 21/02", "jue 22/02"]
    s.step = "ASK_DAY_CHOICE";

    const d = s.data.days;
    return sendText(
      from,
      `Genial ✅ Tengo estos días libres:\n` +
        `1️⃣ ${d[0]}\n` +
        `2️⃣ ${d[1]}\n` +
        `3️⃣ ${d[2]}\n\n` +
        `Responde 1, 2 o 3. O escribe *otro* si quieres proponer otro día.`
    );
  }

  // Paso 2: elegir uno de los 3 días, o pedir otro
  if (s.step === "ASK_DAY_CHOICE") {
    if (t.includes("otro")) {
      s.step = "ASK_DAY_TEXT";
      return sendText(from, `Vale 🙂 dime qué día te viene bien (ej: jueves / 12-03 / mañana).`);
    }

    const idx = Number(t) - 1;
    const days = Array.isArray(s.data?.days) ? s.data.days : [];

    if (Number.isNaN(idx) || idx < 0 || idx >= days.length) {
      return sendText(from, `Elige 1, 2 o 3. O escribe *otro* para proponer otro día.`);
    }

    s.data.day = days[idx];
    s.step = "ASK_TIME";
    return sendText(from, `Perfecto ✅ ¿Prefieres *mañana* o *tarde*? (o una hora, ej: 17:30)`);
  }

  // Paso 2B: el usuario propone otro día manual
  if (s.step === "ASK_DAY_TEXT") {
    s.data.day = text;
    s.step = "ASK_TIME";
    return sendText(from, `Perfecto ✅ ¿Prefieres *mañana* o *tarde*? (o una hora, ej: 17:30)`);
  }

  // Paso 3: hora/franja
  if (s.step === "ASK_TIME") {
    s.data.time = text;
    s.step = "ASK_NAME";
    return sendText(from, `Último paso 🙂 ¿Cómo te llamas? (nombre y apellido)`);
  }

  // Paso 4: nombre
  if (s.step === "ASK_NAME") {
    s.data.name = text;
    s.step = "CONFIRM";
    return sendText(
      from,
      `Confirma tu cita:\n` +
        `• Especialidad: *${s.data.specialty}*\n` +
        `• Día: *${s.data.day}*\n` +
        `• Hora: *${s.data.time}*\n` +
        `• Nombre: *${s.data.name}*\n\n` +
        `Responde *SI* para confirmar o *NO* para cancelar.`
    );
  }

  // Paso 5: confirmar -> guardar en Sheets (y el email lo hará Apps Script)
  if (s.step === "CONFIRM") {
    if (t === "no" || t === "cancelar") {
      resetSession(from);
      return sendText(from, `Entendido ✅ Cancelado. Escribe *hola* para empezar.`);
    }

    if (t !== "si" && t !== "sí" && t !== "ok" && !t.includes("confirm")) {
      return sendText(from, `Responde *SI* para confirmar o *NO* para cancelar.`);
    }

    if (!SHEET_WEBHOOK_URL || !SHEET_WEBHOOK_URL.startsWith("https://")) {
      console.log("SHEET_WEBHOOK_URL mal configurada:", SHEET_WEBHOOK_URL);
      resetSession(from);
      return sendText(from, `Ahora mismo no puedo guardar la cita 😕 (configuración). Escribe *hola*.`);
    }

    try {
      await axios.post(SHEET_WEBHOOK_URL, {
        telefono: from,
        nombre: s.data.name,
        especialidad: s.data.specialty,
        dia: s.data.day,
        hora: s.data.time,
        estado: "pendiente",
      });
    } catch (err) {
      console.log("Error guardando en Sheets:", err?.response?.data || err.message);
      resetSession(from);
      return sendText(from, `Hubo un error guardando tu cita 😕 Intenta de nuevo con *hola*.`);
    }

    resetSession(from);
    return sendText(
      from,
      `✅ ¡Listo! Hemos recibido tu solicitud.\n\n` +
        `📌 Resumen:\n` +
        `• ${s.data.specialty}\n` +
        `• ${s.data.day} — ${s.data.time}\n` +
        `• ${s.data.name}\n\n` +
        `📲 Recepción la confirmará en breve.\n` +
        `Escribe *hola* para volver al menú.`
    );
  }

  // fallback
  resetSession(from);
  return sendText(from, `He reiniciado el proceso. Escribe *hola* para empezar.`);
}

/* ================= HELPERS ================= */

// Devuelve N próximos días laborables en formato corto (es-ES)
function nextBusinessDaysLabels(n) {
  const out = [];
  const d = new Date();
  // empezamos desde mañana
  d.setDate(d.getDate() + 1);

  while (out.length < n) {
    const day = d.getDay(); // 0 dom, 6 sáb
    if (day !== 0 && day !== 6) {
      out.push(formatDayLabelES(d));
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function formatDayLabelES(dateObj) {
  const days = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  return `${days[dateObj.getDay()]} ${dd}/${mm}`;
}

/* ================= SEND TEXT ================= */
async function sendText(to, text) {
  const url = `${GRAPH}/${process.env.WA_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}
