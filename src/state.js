// Memoria simple en RAM (vale para MVP)
// OJO: si Render reinicia, se pierde. Luego lo pasamos a base de datos.
const sessions = new Map();

export function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { step: "IDLE", data: {} });
  }
  return sessions.get(phone);
}

export function resetSession(phone) {
  sessions.set(phone, { step: "IDLE", data: {} });
}
