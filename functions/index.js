const {onSchedule} = require("firebase-functions/v2/scheduler");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

exports.checkUpcomingEvents = onSchedule("every 5 minutes", async () => {
  const pad = (n) => String(n).padStart(2, "0");

  // Hora actual en Argentina (UTC-3)
  const now = new Date();
  const argNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);

  const fmtDate = (d) =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const fmtTime = (d) =>
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

  const todayStr = fmtDate(argNow);
  const nowTimeStr = fmtTime(argNow); // hora actual ARG en HH:MM

  // Ventana: eventos que empiecen entre ahora y ahora+17min
  // Al correr cada 5 min con ventana de 17 min, siempre hay superposición:
  // garantiza que ningún evento se pierda, y el deduplicado evita dobles envíos.
  const cutoffMs = argNow.getTime() + 17 * 60 * 1000;
  const cutoffArgDate = new Date(cutoffMs);
  const cutoffTimeStr = fmtTime(cutoffArgDate);
  // Si la ventana cruza medianoche, el cutoff puede ser del día siguiente
  const cutoffDateStr = fmtDate(cutoffArgDate);

  console.log(`[ARG] Ahora: ${todayStr} ${nowTimeStr} | Ventana hasta: ${cutoffDateStr} ${cutoffTimeStr}`);

  const tokensSnap = await db.collection("fcm_tokens").get();
  console.log(`Tokens registrados: ${tokensSnap.size}`);

  for (const tokenDoc of tokensSnap.docs) {
    const uid = tokenDoc.id;
    const {token} = tokenDoc.data();
    if (!token) continue;

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) continue;

    const {events = []} = userSnap.data();

    // Filtrar eventos que estén dentro de la ventana [ahora, ahora+17min]
    const upcoming = events.filter((ev) => {
      if (!ev.date || !ev.start) return false;

      // Normalizar start a HH:MM (ej: "9:00" → "09:00")
      const parts = String(ev.start).split(":");
      if (parts.length < 2) return false;
      const start = parts[0].padStart(2, "0") + ":" + parts[1].padStart(2, "0");

      // El evento tiene que ser hoy (o mañana si la ventana cruza medianoche)
      const eventDateOk = ev.date === todayStr || ev.date === cutoffDateStr;
      if (!eventDateOk) return false;

      // Comparar como strings HH:MM (funciona porque el formato es fijo)
      // Caso normal: evento hoy, entre nowTime y cutoffTime
      if (ev.date === todayStr && ev.date === cutoffDateStr) {
        return start >= nowTimeStr && start <= cutoffTimeStr;
      }
      // Caso cruce de medianoche: hoy >= nowTime, o mañana <= cutoffTime
      if (ev.date === todayStr) return start >= nowTimeStr;
      if (ev.date === cutoffDateStr) return start <= cutoffTimeStr;
      return false;
    });

    if (upcoming.length === 0) continue;
    console.log(`uid=${uid}: ${upcoming.length} evento(s) en ventana`);

    for (const ev of upcoming) {
      // Calcular minutos reales hasta el evento para el mensaje
      const parts = String(ev.start).split(":");
      const evMs = new Date(
          `${ev.date}T${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}:00`
      ).getTime() + 3 * 60 * 60 * 1000; // convertir a UTC sumando 3h (ARG→UTC)
      const minsLeft = Math.round((evMs - now.getTime()) / 60000);
      const minsText = minsLeft <= 1 ? "ahora mismo" :
        minsLeft < 60 ? `en ${minsLeft} minutos` :
        `a las ${ev.start}`;

      // Deduplicar: usar un documento en Firestore para registrar notifs enviadas
      // Clave: uid_eventId_fecha — expira automáticamente porque solo se consulta el día actual
      const dedupKey = `${uid}_${ev.id}_${ev.date}`;
      const dedupRef = db.collection("notif_sent").doc(dedupKey);
      const dedupSnap = await dedupRef.get();

      if (dedupSnap.exists) {
        console.log(`Ya notificado: "${ev.title}" (${dedupKey})`);
        continue;
      }

      try {
        await getMessaging().send({
          token,
          notification: {
            title: `📅 ${ev.title}`,
            body: `Empieza ${minsText} — ${ev.start}`,
          },
          webpush: {
            fcmOptions: {
              link: "https://malenasein.github.io/organizador/",
            },
            notification: {
              icon: "https://malenasein.github.io/organizador/icons/icon-192.png",
              badge: "https://malenasein.github.io/organizador/icons/icon-192.png",
            },
          },
          data: {eventId: String(ev.id)},
        });

        // Marcar como enviado con TTL de 24h (se limpia con una función de limpieza o TTL de Firestore)
        await dedupRef.set({
          sentAt: now.toISOString(),
          title: ev.title,
          uid,
        });

        console.log(`✅ Enviada: "${ev.title}" uid=${uid} (${minsLeft} min)`);
      } catch (err) {
        console.error(`❌ Error uid=${uid}: ${err.message}`);
        if (err.code === "messaging/registration-token-not-registered") {
          await db.collection("fcm_tokens").doc(uid).delete();
          console.log(`Token eliminado para uid=${uid}`);
          break; // no seguir con otros eventos de este usuario
        }
      }
    }
  }
});

// Limpiar registros de deduplicación viejos (corre 1 vez por día a las 3 AM ARG = 6 UTC)
exports.cleanupNotifSent = onSchedule("0 6 * * *", async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const snap = await db.collection("notif_sent").where("sentAt", "<", cutoff).get();
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  console.log(`Limpieza: ${snap.size} registros eliminados`);
});