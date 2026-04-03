const {onSchedule} = require("firebase-functions/v2/scheduler");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");

// Convierte Date a fecha ARG como objeto {dateStr, timeStr}
function argTime(date) {
  const arg = new Date(date.getTime() - 3 * 60 * 60 * 1000); // UTC-3
  return {
    dateStr: `${arg.getUTCFullYear()}-${pad(arg.getUTCMonth()+1)}-${pad(arg.getUTCDate())}`,
    timeStr: `${pad(arg.getUTCHours())}:${pad(arg.getUTCMinutes())}`,
  };
}

// Normaliza "9:00" → "09:00"
function normalizeTime(t) {
  const parts = String(t || "").split(":");
  if (parts.length < 2) return null;
  return parts[0].padStart(2, "0") + ":" + parts[1].padStart(2, "0");
}

// Envía una notificación FCM y maneja token inválido
async function sendNotif(token, uid, payload) {
  try {
    await getMessaging().send({
      token,
      notification: {title: payload.title, body: payload.body},
      webpush: {
        fcmOptions: {link: "https://malenasein.github.io/organizador/"},
        notification: {
          icon: "https://malenasein.github.io/organizador/icons/icon-192.png",
          badge: "https://malenasein.github.io/organizador/icons/icon-192.png",
        },
      },
      data: payload.data || {},
    });
    console.log(`✅ Enviada: "${payload.title}" → uid=${uid}`);
    return true;
  } catch (err) {
    console.error(`❌ Error uid=${uid}: ${err.message}`);
    if (err.code === "messaging/registration-token-not-registered") {
      await db.collection("fcm_tokens").doc(uid).delete();
      console.log(`🗑 Token eliminado uid=${uid}`);
    }
    return false;
  }
}

// Deduplicación atómica con transacción: devuelve true si hay que enviar
async function claimNotif(key) {
  const ref = db.collection("notif_sent").doc(key);
  try {
    const sent = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false; // ya enviado
      tx.set(ref, {sentAt: new Date().toISOString()});
      return true;
    });
    return sent;
  } catch (e) {
    console.error("Error en transacción dedup:", e.message);
    return false; // ante la duda, no enviar
  }
}

// ─── FUNCIÓN PRINCIPAL ────────────────────────────────────────────────────────
exports.checkUpcoming = onSchedule("every 5 minutes", async () => {
  const now = new Date();

  // Ventana exacta: eventos que empiecen entre 13 y 18 minutos desde ahora
  // Corriendo cada 5 min con ventana de 5 min → sin huecos, sin solapamiento
  const winStart = new Date(now.getTime() + 13 * 60 * 1000);
  const winEnd   = new Date(now.getTime() + 18 * 60 * 1000);

  const {dateStr: dateStart, timeStr: timeStart} = argTime(winStart);
  const {dateStr: dateEnd,   timeStr: timeEnd}   = argTime(winEnd);

  console.log(`Ventana ARG: ${dateStart} ${timeStart} → ${dateEnd} ${timeEnd}`);

  const tokensSnap = await db.collection("fcm_tokens").get();
  if (tokensSnap.empty) { console.log("Sin tokens"); return; }

  for (const tokenDoc of tokensSnap.docs) {
    const uid = tokenDoc.id;
    const {token} = tokenDoc.data();
    if (!token) continue;

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) continue;
    const {events = [], tasks = []} = userSnap.data();

    // ── EVENTOS ────────────────────────────────────────────────────────────
    const upcomingEvents = events.filter((ev) => {
      if (!ev.date || !ev.start) return false;
      const start = normalizeTime(ev.start);
      if (!start) return false;
      // Caso normal (mismo día) o cruce de medianoche
      if (ev.date === dateStart && ev.date === dateEnd) {
        return start >= timeStart && start <= timeEnd;
      }
      if (ev.date === dateStart) return start >= timeStart;
      if (ev.date === dateEnd)   return start <= timeEnd;
      return false;
    });

    for (const ev of upcomingEvents) {
      const key = `ev_${uid}_${ev.id}_${ev.date}`;
      const shouldSend = await claimNotif(key);
      if (!shouldSend) { console.log(`Skip dedup: ${key}`); continue; }

      const ok = await sendNotif(token, uid, {
        title: `📅 ${ev.title}`,
        body: `Empieza en 15 minutos — ${ev.start}`,
        data: {eventId: String(ev.id), type: "event"},
      });
      if (!ok) break; // token inválido, saltar al próximo usuario
    }

    // ── TAREAS con fecha de vencimiento ────────────────────────────────────
    // Notificar tareas pendientes que vencen HOY a las 08:00 ARG
    // (se detecta porque winStart puede caer en esa hora)
    const {dateStr: todayArg, timeStr: nowTimeArg} = argTime(now);
    const isEarlyMorning = nowTimeArg >= "07:55" && nowTimeArg <= "08:05";

    if (isEarlyMorning) {
      const dueTasks = tasks.filter((t) =>
        t.dueDate === todayArg &&
        t.status !== "completada" &&
        t.status !== "done"
      );

      for (const task of dueTasks) {
        const key = `task_${uid}_${task.id}_${task.dueDate}`;
        const shouldSend = await claimNotif(key);
        if (!shouldSend) { console.log(`Skip dedup task: ${key}`); continue; }

        await sendNotif(token, uid, {
          title: `✅ Tarea vence hoy`,
          body: `"${task.title}" — Prioridad ${task.priority || "normal"}`,
          data: {taskId: String(task.id), type: "task"},
        });
      }
    }
  }
});

// ─── LIMPIEZA DIARIA ──────────────────────────────────────────────────────────
// Borra registros de deduplicación de más de 24h — corre a las 3 AM ARG (6 UTC)
exports.cleanupNotifSent = onSchedule("0 6 * * *", async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const snap = await db.collection("notif_sent")
      .where("sentAt", "<", cutoff)
      .get();

  if (snap.empty) { console.log("Nada que limpiar"); return; }

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  console.log(`🗑 Limpieza: ${snap.size} registros eliminados`);
});