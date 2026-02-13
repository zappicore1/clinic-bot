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

  // Seguridad: si falta APPS_SCRIPT_URL (para sugerencias/reservas)
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_URL.startsWith("https://")) {
    console.log("APPS_SCRIPT_URL mal configurada:", APPS_SCRIPT_URL);
  }

  // comandos globales
  if (t === "hola" || t === "menu" || t === "menú") {
    resetSession(from);
    return sendText(
      from,
      `¡Hola! 👋 Soy Clinic Bot.\n\n` +
        `1️⃣ Pedir cita\n` +
        `2️⃣ Precios\n` +
        `3️⃣ Horario\n\n` +
        `Escribe *cancelar* para parar el proceso.`
    );
  }

  if (t === "cancelar" || t === "reiniciar") {
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
    return sendText(from, `¿Para qué especialidad? (ej: dental, fisio, estética)`);
  }

  if (t === "2" || t.includes("precio")) {
    return sendText(from, `💶 Precios orientativos:\n- Consulta: 30€\n- Revisión: 20€\n\nEscribe *hola* para menú.`);
  }

  if (t === "3" || t.includes("horario")) {
    return sendText(from, `🕒 Horario:\nL–V 9–14 y 16–20\nS 10–13\n\nEscribe *hola* para menú.`);
  }

  return sendText(from, `No te he entendido 😅 Escribe *hola*`);
}

/* ================= BOOKING FLOW (MODO B) ================= */
async function handleBookingFlow({ from, text, t, s }) {
  // 1️⃣ Especialidad
  if (s.step === "ASK_SPECIALTY") {
    s.data.specialty = text;
    s.step = "ASK_DAY";
    return sendText(from, `Perfecto ✅ ¿Qué día te viene bien? (jueves / mañana / 12-03)`);
  }

  // 2️⃣ Día -> pedir sugerencias (Apps Script: action=suggest)
  if (s.step === "ASK_DAY") {
    s.data.dayText = text;

    if (!APPS_SCRIPT_URL || !APPS_SCRIPT_URL.startsWith("https://")) {
      resetSession(from);
      return sendText(from, `No está configurada la agenda 😕 (APPS_SCRIPT_URL). Escribe *hola*.`);
    }

    let r;
    try {
      r = await axios.post(APPS_SCRIPT_URL, {
        action: "suggest",
        phone: from,
        specialty: s.data.specialty,
        dayText: s.data.dayText,
      });
    } catch (err) {
      console.log("Error llamando suggest:", err?.response?.data || err.message);
      return sendText(from, `Error consultando agenda 😕 Prueba con otro día.`);
    }

    console.log("RESPUESTA APPS SCRIPT (suggest):", JSON.stringify(r?.data));

    if (!r?.data?.ok) {
      return sendText(
        from,
        `No pude sacar huecos 😕 (${r?.data?.error || "error"})\nPrueba con otro día (ej: viernes o mañana).`
      );
    }

    const slots = Array.isArray(r.data.slots) ? r.data.slots : [];
    if (slots.length === 0) {
      return sendText(from, `No hay huecos libres ese día 😕\nPrueba con otro día.`);
    }

    // normalizamos labels por si vinieran raros
    const normalized = slots.map((x, i) => ({
      startISO: x?.startISO,
      endISO: x?.endISO,
      label: x?.label || `Opción ${i + 1}`,
    }));

    s.data.slots = normalized;
    s.step = "ASK_SLOT";

    let msg = `Perfecto. Huecos disponibles:\n`;
    normalized.forEach((x, i) => {
      msg += `${i + 1}️⃣ ${x.label}\n`;
    });
    msg += `\nResponde 1, 2 o 3 (o escribe *otro día*).`;

    return sendText(from, msg);
  }

  // 3️⃣ Elegir hueco
  if (s.step === "ASK_SLOT") {
    if (t.includes("otro")) {
      s.step = "ASK_DAY";
      return sendText(from, `Vale 🙂 dime otro día (ej: miércoles / 15-03 / mañana).`);
    }

    const slots = Array.isArray(s.data?.slots) ? s.data.slots : [];
    if (slots.length === 0) {
      s.step = "ASK_DAY";
      return sendText(from, `Se perdió la lista de huecos 😅 Dime otra vez el día (ej: jueves).`);
    }

    const idx = Number(t) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= slots.length) {
      return sendText(from, `Elige 1, 2 o 3. (o escribe *otro día*)`);
    }

    s.data.slot = slots[idx];
    s.step = "ASK_NAME";
    return sendText(from, `Genial ✅ Para reservar *${s.data.slot.label}*, dime tu nombre y apellido.`);
  }

  // 4️⃣ Nombre
  if (s.step === "ASK_NAME") {
    s.data.name = text;
    s.step = "CONFIRM";

    const label = s.data?.slot?.label || "(hueco sin etiqueta)";
    return sendText(
      from,
      `Confirma tu cita:\n` +
        `🩺 ${s.data.specialty}\n` +
        `📅 ${label}\n` +
        `👤 ${s.data.name}\n\n` +
        `Responde *SI* para confirmar o *NO* para cancelar.`
    );
  }

  // 5️⃣ Confirmar -> reservar (Apps Script: action=book)
  if (s.step === "CONFIRM") {
    if (t === "no" || t === "cancelar") {
      resetSession(from);
      return sendText(from, `Cancelado ❌ Escribe *hola*`);
    }

    if (t !== "si" && t !== "sí" && t !== "ok" && !t.includes("confirm")) {
      return sendText(from, `Responde *SI* para confirmar o *NO* para cancelar.`);
    }

    if (!APPS_SCRIPT_URL || !APPS_SCRIPT_URL.startsWith("https://")) {
      resetSession(from);
      return sendText(from, `No está configurada la agenda 😕 (APPS_SCRIPT_URL). Escribe *hola*.`);
    }

    const slotStartISO = s.data?.slot?.startISO;
    if (!slotStartISO) {
      s.step = "ASK_DAY";
      return sendText(from, `No encuentro el hueco elegido 😅 Dime otra vez el día (ej: jueves).`);
    }

    let r;
    try {
      r = await axios.post(APPS_SCRIPT_URL, {
        action: "book",
        phone: from,
        name: s.data.name,
        specialty: s.data.specialty,
        dayText: s.data.dayText,
        slotStartISO,
      });
    } catch (err) {
      console.log("Error llamando book:", err?.response?.data || err.message);
      resetSession(from);
      return sendText(from, `Error reservando 😕 Intenta otra vez con *hola*.`);
    }

    console.log("RESPUESTA APPS SCRIPT (book):", JSON.stringify(r?.data));

    if (!r?.data?.ok) {
      // ejemplo: hueco ocupado o error
      s.step = "ASK_DAY";
      return sendText(from, `Uy 😅 ${r?.data?.error || "No pude reservar"}\nDime otro día para proponerte huecos.`);
    }

    const label = r.data.label || s.data?.slot?.label || "cita confirmada";
    resetSession(from);
    return sendText(
      from,
      `✅ Cita confirmada\n` +
        `📅 ${label}\n` +
        `👤 ${s.data.name}\n\n` +
        `¡Te esperamos!`
    );
  }

  // fallback
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
