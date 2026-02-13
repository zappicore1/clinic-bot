import axios from "axios";
import { getSession, resetSession } from "./state.js";

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
    return sendText(from, `Genial ✅ ¿Qué día te viene bien? (Ej: lunes / mañana / 12-03)`);
  }

  // Paso 2: día
  if (s.step === "ASK_DAY") {
    s.data.day = text;
    s.step = "ASK_TIME";
    return sendText(from, `Perfecto. ¿Prefieres *mañana* o *tarde*? (o escribe una hora aprox, ej: 17:30)`);
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

    // Confirmación
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

  // Paso 5: confirmar
  if (s.step === "CONFIRM") {
    if (t === "si" || t === "sí" || t === "ok" || t === "confirmo") {
      // Aquí todavía no lo metemos en Calendar; lo dejamos como "solicitud"
      const summary =
        `✅ Solicitud de cita:\n` +
        `Nombre: ${s.data.name}\n` +
        `Especialidad: ${s.data.specialty}\n` +
        `Día: ${s.data.day}\n` +
        `Hora: ${s.data.time}`;

      resetSession(from);
      return sendText(
        from,
        `¡Listo! ✅ He registrado tu solicitud.\n` +
          `Recepción la confirmará en breve.\n\n` +
          `Resumen:\n${summary}\n\n` +
          `Escribe *hola* para volver al menú.`
      );
    }

    resetSession(from);
    return sendText(from, `Entendido ✅ Cancelado. Escribe *hola* para empezar de nuevo.`);
  }

  // Fallback
  resetSession(from);
  return sendText(from, `He reiniciado el proceso. Escribe *1* para pedir cita.`);
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
