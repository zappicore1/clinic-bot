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

  // --- “Inteligencia” ligera ---
  const intent = detectIntent(t);
  const sp = detectSpecialty(t);
  const dayText = detectDayText(t);
  const timeText = detectTimeText(t);

  // Comandos globales
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

  if (intent === "CANCEL") {
    resetSession(from);
    return sendText(from, `Proceso cancelado ✅ Escribe *hola* para empezar.`);
  }

  if (intent === "PRICES" || t === "2") {
    resetSession(from);
    return sendText(
      from,
      `💶 Precios orientativos:\n` +
        `- Consulta: 30€\n` +
        `- Revisión: 20€\n\n` +
        `Escribe *hola* para menú.`
    );
  }

  if (intent === "HOURS" || t === "3") {
    resetSession(from);
    return sendText(
      from,
      `🕒 Horario:\n` +
        `L–V 9:00–14:00 y 16:00–20:00\n` +
        `S 10:00–13:00\n\n` +
        `Escribe *hola* para menú.`
    );
  }

  const s = getSession(from);

  // Si ya está en medio del proceso, seguimos el wizard
  if (s.step !== "IDLE") {
    return handleBookingFlow({ from, text, t, s, sp, dayText, timeText });
  }

  // Arrancar cita por número o por texto libre
  if (t === "1" || intent === "BOOK") {
    s.data = s.data || {};

    // Si ya viene info en la frase, la guardamos
    if (sp) s.data.specialty = sp;
    if (dayText) s.data.day = dayText;
    if (timeText) s.data.time = timeText;

    // Si no tenemos especialidad, la pedimos
    if (!s.data.specialty) {
      s.step = "ASK_SPECIALTY";
      return sendText(from, `Perfecto 📅 ¿Para qué especialidad? (Ej: dental, fisio, estética)`);
    }

    // Si ya tenemos especialidad, pasamos a sugerir 3 días
    s.data.days = nextBusinessDaysLabels(3);
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

  return sendText(from, `No te he entendido 😅 Escribe *hola* para ver el menú.`);
}

/* ================= BOOKING FLOW (SOLO SHEETS) ================= */
async function handleBookingFlow({ from, text, t, s, sp, dayText, timeText }) {
  // Paso 1: especialidad
  if (s.step === "ASK_SPECIALTY") {
    // si el usuario escribe algo como “me duele una muela”, lo detectamos como dental
    s.data.specialty = sp || text;

    // si ya venía un día/hora en el mensaje original, lo guardamos
    if (dayText && !s.data.day) s.data.day = dayText;
    if (timeText && !s.data.time) s.data.time = timeText;

    s.data.days = nextBusinessDaysLabels(3);
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

  // Paso 2: elegir día (1/2/3) o “otro”
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

    // Si ya tenemos hora (porque venía en la frase), saltamos a nombre
    if (s.data.time) {
      s.step = "ASK_NAME";
      return sendText(from, `Perfecto ✅ ¿Cómo te llamas? (nombre y apellido)`);
    }

    s.step = "ASK_TIME";
    return sendText(from, `Perfecto ✅ ¿Prefieres *mañana* o *tarde*? (o una hora, ej: 17:30)`);
  }

  // Paso 2B: usuario propone día manual
  if (s.step === "ASK_DAY_TEXT") {
    s.data.day = text;

    // si venía hora ya, saltamos a nombre
    if (s.data.time) {
      s.step = "ASK_NAME";
      return sendText(from, `Perfecto ✅ ¿Cómo te llamas? (nombre y apellido)`);
    }

    s.step = "ASK_TIME";
    return sendText(from, `Perfecto ✅ ¿Prefieres *mañana* o *tarde*? (o una hora, ej: 17:30)`);
  }

  // Paso 3: hora/franja
  if (s.step === "ASK_TIME") {
    // si escribe una frase con hora, lo intentamos detectar
    s.data.time = detectTimeText(text) || text;
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

  // Paso 5: confirmar -> guardar en Sheets
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

  // Fallback
  resetSession(from);
  return sendText(from, `He reiniciado el proceso. Escribe *hola* para empezar.`);
}

/* ================= “IA” LIGERA: intent + extracción ================= */
function detectIntent(t) {
  if (/(precio|cu[aá]nto|tarifa|coste|costo)/i.test(t)) return "PRICES";
  if (/(horario|abre|abren|cerr[aá]is|cierran|hora de)/i.test(t)) return "HOURS";
  if (/(cancelar|anular|reiniciar|parar)/i.test(t)) return "CANCEL";
  if (/(cita|reserv|agenda|turno|consulta)/i.test(t)) return "BOOK";
  return "UNKNOWN";
}

function detectSpecialty(t) {
  const map = [
    { key: "dental", re: /(dental|dentista|muela|molar|enc[ií]a|encias|caries|c[aá]ries)/i },
    { key: "fisio", re: /(fisio|fisioterapia|contractura|espalda|cuello|lumbar)/i },
    { key: "estética", re: /(estetica|est[eé]tica|botox|b[oó]tox|peeling|relleno|facial)/i },
    { key: "medicina", re: /(medicina|general|doctor|doctora|consulta general)/i },
  ];
  for (const x of map) if (x.re.test(t)) return x.key;
  return null;
}

function detectDayText(t) {
  const days = ["lunes","martes","miercoles","miércoles","jueves","viernes","sabado","sábado","domingo"];
  for (const d of days) {
    if (new RegExp(`\\b${d}\\b`, "i").test(t)) return d;
  }
  if (/\b(mañana|manana)\b/i.test(t)) return "mañana";
  const m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

function detectTimeText(t) {
  if (/\bmañana\b/i.test(t) && !/\bpasado mañana\b/i.test(t)) return "mañana";
  if (/\btarde\b/i.test(t)) return "tarde";
  const m = t.match(/\b([01]?\d|2[0-3])[:.](\d{2})\b/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  return null;
}

/* ================= HELPERS: 3 días libres ================= */
function nextBusinessDaysLabels(n) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() + 1); // desde mañana

  while (out.length < n) {
    const day = d.getDay(); // 0 dom, 6 sáb
    if (day !== 0 && day !== 6) out.push(formatDayLabelES(d));
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
