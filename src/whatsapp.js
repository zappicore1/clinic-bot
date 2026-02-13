import axios from "axios";
import { getSession, resetSession } from "./state.js";

const GRAPH = "https://graph.facebook.com/v24.0";
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // ponla en Render env vars
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

  // Comandos globales
  if (t === "menu" || t === "menú" || t === "hola") {
    resetSession(from);
    return sendText(
      from,
      `¡Hola! 👋 Soy Clinic Bot.\n\n` +
        `Escribe:\n` +
        `1️⃣ Cita\n` +
        `2️⃣ Precios\n` +
        `3️⃣ Horario\n` +
        `4️⃣ Humano`
    );
  }

  if (t === "cancelar" || t === "reiniciar") {
    resetSession(from);
    return sendText(from, `Listo ✅ He cancelado el proceso. Escribe *hola* para empezar.`);
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

  if (t === "4" || t.includes("humano") || t.includes("persona") || t.includes("recepcion")) {
    return sendText(from, `De acuerdo 👩‍💼 Te pasa recepción en breve. Si quieres, escribe *1* para pedir cita.`);
  }

  return sendText(from, `No te he entendido 😅 Escribe *hola* para ver el menú.`);
}

async function handleBookingFlow({ from, text, t, s }) {
  // Paso 1: especialidad
  if (s.step === "ASK_SPECIALTY") {
    s.data.specialty = text;
    s.step = "ASK_DAY";
    return sendText(from, `Genial ✅ ¿Qué día te viene bien? (Ej: lunes / 12-03 / mañana)`);
  }

  // Paso 2: día -> pedir sugerencias a Calendar
  if (s.step === "ASK_DAY") {
    s.data.dayText = text;

    // llamar Apps Script para sugerir 3 huecos
    const r = await axios.post(APPS_SCRIPT_URL, {
      action: "suggest",
      phone: from,
      specialty: s.data.specialty,
      dayText: s.data.dayText
    });

    if (!r.data?.ok) {
      return sendText(from, `No pude sacar huecos 😕 (${r.data?.error || "error"})\nPrueba con otro día (ej: lunes o 12/03).`);
    }

    const slots = r.data.slots || [];
    if (slots.length === 0) {
      return sendText(from, `No hay huecos libres ese día 😕\nPrueba con otro día (ej: martes o mañana).`);
    }

    // guardamos slots en sesión
    s.data.slots = slots;
    s.step = "ASK_SLOT";

    let msg = `Perfecto. Huecos disponibles:\n`;
    slots.forEach((x, i) => {
      msg += `${i + 1}️⃣ ${x.label}\n`;
    });
    msg += `\nResponde 1, 2 o 3 (o escribe *otro día*).`;

    return sendText(from, msg);
  }

  // Paso 3: elegir slot
  if (s.step === "ASK_SLOT") {
    if (t.includes("otro")) {
      s.step = "ASK_DAY";
      return sendText(from, `Vale 🙂 dime otro día (ej: miércoles / 15-03 / mañana).`);
    }

    const idx = Number(t) - 1;
    const slots = s.data.slots || [];
    if (Number.isNaN(idx) || idx < 0 || idx >= slots.length) {
      return sendText(from, `Elige 1, 2 o 3. (o escribe *otro día*)`);
    }

    s.data.slot = slots[idx]; // {startISO,endISO,label}
    s.step = "ASK_NAME";
    return sendText(from, `Genial ✅ Para reservar ${s.data.slot.label}, dime tu nombre y apellido.`);
  }

  // Paso 4: nombre
  if (s.step === "ASK_NAME") {
    s.data.name = text;
    s.step = "CONFIRM";
    return sendText(
      from,
      `Confirma tu cita:\n` +
        `• Especialidad: *${s.data.specialty}*\n` +
        `• Día/hora: *${s.data.slot?.label}*\n` +
        `• Nombre: *${s.data.name}*\n\n` +
        `Responde *SI* para confirmar o *NO* para cancelar.`
    );
  }

  // Paso 5: confirmar -> reservar en Calendar + Sheets
   // Paso 5: confirmar
  if (s.step === "CONFIRM") {
    if (t === "si" || t === "sí" || t === "ok" || t === "confirmo") {

      // 1️⃣ Guardar en Google Sheets
      try {
        await axios.post(process.env.SHEET_WEBHOOK_URL, {
          telefono: from,
          nombre: s.data.name,
          especialidad: s.data.specialty,
          dia: s.data.day,
          hora: s.data.time,
          estado: "pendiente",
        });
      } catch (err) {
        console.log("Error guardando en Sheets:", err?.response?.data || err.message);
      }

      // 2️⃣ Respuesta automática al paciente
      await sendText(
        from,
        `✅ ¡Perfecto! Hemos recibido tu solicitud.\n\n` +
          `📌 Resumen:\n` +
          `• Especialidad: *${s.data.specialty}*\n` +
          `• Día: *${s.data.day}*\n` +
          `• Hora: *${s.data.time}*\n\n` +
          `📲 Recepción la confirmará en breve.\n` +
          `Escribe *hola* para volver al menú.`
      );

      resetSession(from);
      return;
    }

    resetSession(from);
    return sendText(from, `Entendido ✅ Cita cancelada. Escribe *hola* para empezar.`);
  }

  // Fallback
  resetSession(from);
  return sendText(from, `He reiniciado el proceso. Escribe *1* para pedir cita.`);
}



    // 2️⃣ Respuesta automática al paciente
    await sendText(
      from,
      `✅ ¡Perfecto! Hemos recibido tu solicitud.\n\n` +
      `📌 Resumen:\n` +
      `• Especialidad: *${s.data.specialty}*\n` +
      `• Día: *${s.data.day}*\n` +
      `• Hora: *${s.data.time}*\n\n` +
      `📲 Recepción la confirmará en breve.\n` +
      `Escribe *hola* para volver al menú.`
    );
    resetSession(from);
    return;
  }

  resetSession(from);
  return sendText(from, `Entendido ✅ Cita cancelada. Escribe *hola* para empezar.`);
}


  // Fallback
  resetSession(from);
  return sendText(from, `He reiniciado el proceso. Escribe *1* para pedir cita.`);
}

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
