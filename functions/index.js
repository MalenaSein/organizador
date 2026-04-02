const {onSchedule} = require("firebase-functions/v2/scheduler");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

// Se ejecuta cada 15 minutos
exports.checkUpcomingEvents = onSchedule("every 15 minutes", async () => {
  // Hora actual en Argentina (UTC-3)
  const now = new Date();
  const argOffset = -3 * 60; // minutos
  const argNow = new Date(now.getTime() + argOffset * 60 * 1000);

  // En 15 minutos (hora argentina)
  const in15 = new Date(argNow.getTime() + 15 * 60 * 1000);
  const in16 = new Date(argNow.getTime() + 16 * 60 * 1000);

  const pad = (n) => String(n).padStart(2, "0");

  // Fecha y horarios en hora argentina
  const dateStr = 
  `${in15.getUTCFullYear()}-${pad(in15.getUTCMonth()+1)}-${pad(in15.getUTCDate())}`;
  const timeStr15 = `${pad(in15.getUTCHours())}:${pad(in15.getUTCMinutes())}`;
  const timeStr16 = `${pad(in16.getUTCHours())}:${pad(in16.getUTCMinutes())}`;

  console.log(`Buscando eventos para fecha=${dateStr} 
    entre ${timeStr15} y ${timeStr16} (hora ARG)`);

  // Obtener todos los tokens
  const tokensSnap = await db.collection("fcm_tokens").get();
  console.log(`Tokens encontrados: ${tokensSnap.size}`);

  for (const tokenDoc of tokensSnap.docs) {
    const uid = tokenDoc.id;
    const token = tokenDoc.data().token;
    if (!token) continue;

    // Obtener eventos del usuario
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) continue;

    const {events = []} = userSnap.data();
    console.log(`Usuario ${uid}: ${events.length} eventos totales`);

    // Filtrar eventos que empiezan en los próximos 15-16 min (hora argentina)
    const upcoming = events.filter((ev) => {
      if (!ev.date || !ev.start) return false;
      const match = ev.date === dateStr &&
        ev.start >= timeStr15 && ev.start < timeStr16;
      if (match) console.log(`  → Evento encontrado: 
        "${ev.title}" a las ${ev.start}`);
      return match;
    });

    console.log(`Usuario ${uid}: ${upcoming.length} eventos próximos`);

    for (const ev of upcoming) {
      try {
        await getMessaging().send({
          token,
          notification: {
            title: `📅 ${ev.title}`,
            body: `Empieza en 15 minutos — ${ev.start}`,
          },
          webpush: {
            fcmOptions: {link: "https://malenasein.github.io/organizador/"},
            notification: {
              icon: "https://malenasein.github.io/organizador/icons/icon-192.png",
              badge: "https://malenasein.github.io/organizador/icons/icon-192.png",
            },
          },
          data: {eventId: String(ev.id)},
        });
        console.log(`✅ Notificación enviada: "${ev.title}" a uid=${uid}`);
      } catch (err) {
        console.error(`❌ Error enviando a uid=${uid}:`, err.message);
        // Token inválido → borrarlo
        if (err.code === "messaging/registration-token-not-registered") {
          await db.collection("fcm_tokens").doc(uid).delete();
          console.log(`🗑 Token inválido eliminado para uid=${uid}`);
        }
      }
    }
  }
});
