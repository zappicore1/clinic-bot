// src/whatsapp.js
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

  const from = msg.from; // teléfono del usuario (wa_id)
  const text = (msg?.text?.body || "").trim();
  const t = text.toLowerCase();

  // Comandos globales
  if (t === "hola" || t === "menu" || t === "menú") {
    resetSession(from);
    return sendText(
      from,
      `Hola 👋 Escribe:\n` +
        `• *cita* para pedir cita\n` +
        `• *precios*\n` +
        `• *horario*\n\n` +
        `En cualquier momento: *cancelar*`
    );
  }

  if (t === "cancelar" || t === "reiniciar") {
    resetSession(from);
    return sendText(from, `Listo ✅ Proceso cancelado. Escribe *hola* para empezar.`);
  }

  // Si no hay URL del Apps Script, avisar (evita misterio)
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_URL.startsWith("https://")) {
    console.log("APPS_SCRIPT_URL missing/bad:", APPS_SCRIPT_URL);
  }

  const s = getSession(from);

  // Si está en flujo, continuamos
  if (s.step && s.step !== "IDLE") {
    return handleBookingFlow({ from, text, t, s });
  }

  // Menú básico
  if (t.includes("cita") || t === "1") {
    s.step = "ASK_SPECIALTY";
    s.data = {};
    return sendText(from, `Perfecto 📅 ¿Para qué especialidad? (ej: dental, fisio, estética)`);
  }

  if (t.includes("precio") || t === "2") {
    return sendText(from, `💶 Precios orientativos:\n- Consulta: 30€\n- Revisión: 20€\n\nEscribe *hola* para menú.`);
  }

  if (t.includes("horario") || t === "3") {
    return sendText(
      from,
      `🕒 Horario:\nL–V 9:00–14:00 y 16:00–20:00\nS 10:00–13:00\n\nEscribe *hola* para menú.`
    );
  }

  return sendText(from, `No te he entendido 😅 Escribe *hola* para ver opciones.`);
}

/* ================= BOOKING FLOW (SIN CALENDAR) ================= */
async function handleBookingFlow({ from, text, t, s }) {
  // Paso 1: especialidad
  if (s.step === "ASK_SPECIALTY") {
    s.data.specialty = text;
    s.step = "ASK_DAY";
    return sendText(from, `Genial ✅ ¿Qué día te viene bien? (ej: martes / mañana / 12-03)`);
  }

  // Paso 2: día -> pedir 3 opciones al Apps Script
  if (s.step === "ASK_DAY") {
    s.data.dayText = text;

    if (!APPS_SCRIPT_URL || !APPS_SCRIPT_URL.startsWith("https://")) {
      // fallback sin Apps Script (por si la env var está mal)
      const fallback = [
        { label: "Mañana 10:00–10:30", startISO: "", endISO: "" },
        { label: "Mañana 12:00–12:30", startISO: "", endISO: "" },
        { label: "Tarde 17:30–18:00", startISO: "", endISO: "" }
      ];
      s.data.slots = fallback;
      s.step = "ASK_SLOT";
      return sendText(
        from,
        `Tengo estos huecos:\n\n` +
          `1️⃣ ${fallback[0].label}\n` +
          `2️⃣ ${fallback[1].label}\n` +
          `3️⃣ ${fallback[2].label}\n\n` +
          `Responde 1, 2 o 3 (o escribe *otro día*).`
      );
    }

    let r;
    try {
      r = await axios.post(APPS_SCRIPT_URL, {
        action: "suggest",
        phone: from,
        specialty: s.data.specialty,
        dayText: s.data.dayText
      });
    } catch (e) {
      console.log("ERROR suggest:", e?.response?.data || e.message);
      return sendText(from, `No pude consultar huecos 😕. Dime otro día o prueba de nuevo.`);
    }

    console.log("SUGGEST response:", JSON.stringify(r?.data));

    const slots = Array.isArray(r?.data?.slots) ? r.data.slots : [];
    if (slots.length < 1) {
      return sendText(from, `Ese día no me salen huecos 😕. Dime otro día (ej: miércoles / mañana).`);
    }

    // Guardar opciones en sesión y pedir elección
    s.data.slots = slots.slice(0, 3);
    s.step = "ASK_SLOT";

    let msg = `Tengo estos huecos:\n\n`;
    s.data.slots.forEach((x, i) => {
      msg += `${i + 1}️⃣ ${x.label || `Opción ${i + 1}`}\n`;
    });
    msg += `\nResponde 1, 2 o 3 (o escribe *otro día*).`;

    return sendText(from, msg);
  }

  // Paso 3: elegir 1/2/3
  if (s.step === "ASK_SLOT") {
    if (t.includes("otro")) {
      s.step = "ASK_DAY";
      return sendText(from, `Vale 🙂 dime otro día (ej: jueves / mañana / 12-03).`);
    }

    if (!Array.isArray(s.data?.slots) || s.data.slots.length === 0) {
      s.step = "ASK_DAY";
      return sendText(from, `Se me perdió la lista 😅. Dime otra vez el día (ej: martes / mañana).`);
    }

    const idx = Number(t) - 1;
    const slots = s.data.slots;

    if (!Number.isInteger(idx) || idx < 0 || idx >= slots.length) {
      return sendText(from, `Elige 1, 2 o 3 (o escribe *otro día*).`);
    }

    s.data.slot = slots[idx]; // {label,startISO,endISO}
    s.step = "ASK_NAME";
    return sendText(from, `Perfecto ✅ Has elegido: *${s.data.slot.label}*\nDime tu nombre y apellido.`);
  }

  // Paso 4: nombre
  if (s.step === "ASK_NAME") {
    s.data.name = text;
    s.step = "CONFIRM";
    return sendText(
      from,
      `Confirma tu solicitud:\n` +
        `• Especialidad: *${s.data.specialty}*\n` +
        `• Opción: *${s.data.slot?.label || "-"}*\n` +
        `• Nombre: *${s.data.name}*\n\n` +
        `Responde *SI* para confirmar o *NO* para cancelar.`
    );
  }

  // Paso 5: confirmar -> guardar en Sheets (Apps Script) + email (Apps Script)
  if (s.step === "CONFIRM") {
    const ok = t === "si" || t === "sí" || t === "ok" || t === "confirmo";

    if (!ok) {
      resetSession(from);
      return sendText(from, `Entendido ✅ Cancelado. Escribe *hola* para volver al menú.`);
    }

    // Guardar en Sheets vía Apps Script
    try {
      if (APPS_SCRIPT_URL && APPS_SCRIPT_URL.startsWith("https://")) {
        await axios.post(APPS_SCRIPT_URL, {
          action: "save",
          telefono: from,
          nombre: s.data.name,
          especialidad: s.data.specialty,
          dia: s.data.dayText,
          hora: s.data.slot?.label || "",
          estado: "pendiente"
        });
      } else {
        console.log("APPS_SCRIPT_URL not set, skipping save.");
      }
    } catch (e) {
      console.log("Error guardando en Sheets:", e?.response?.data || e.message);
      // Aunque falle, respondemos para no dejar al usuario colgado
    }

    await sendText(
      from,
      `✅ ¡Perfecto! Hemos recibido tu solicitud.\n\n` +
        `📌 Resumen:\n` +
        `• ${s.data.specialty}\n` +
        `• ${s.data.slot?.label || s.data.dayText}\n` +
        `• ${s.data.name}\n\n` +
        `📲 Recepción la confirmará en breve.\n` +
        `Escribe *hola* para volver al menú.`
    );

    resetSession(from);
    return;
  }

  // Fallback
  resetSession(from);
  return sendText(from, `He reiniciado el proceso. Escribe *cita* para empezar.`);
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
