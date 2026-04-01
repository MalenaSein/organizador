const {onSchedule} = require("firebase-functions/v2/scheduler");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

// Se ejecuta cada 15 minutos
exports.checkUpcomingEvents = onSchedule("every 15 minutes", async () => {
  const now = new Date();
  const in15 = new Date(now.getTime() + 15 * 60 * 1000);
  const in16 = new Date(now.getTime() + 16 * 60 * 1000);

  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const dateStr15 = fmtDate(in15);
  const timeStr15 = fmtTime(in15);
  const timeStr16 = fmtTime(in16);

  // Obtener todos los tokens
  const tokensSnap = await db.collection("fcm_tokens").get();

  for (const tokenDoc of tokensSnap.docs) {
    const uid = tokenDoc.id;
    const token = tokenDoc.data().token;
    if (!token) continue;

    // Obtener eventos del usuario
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) continue;

    const {events = []} = userSnap.data();

    // Filtrar eventos que empiezan en los próximos 15-16 min
    const upcoming = events.filter((ev) => {
      if (!ev.date || !ev.start) return false;
      return ev.date === dateStr15 &&
      ev.start >= timeStr15 && ev.start < timeStr16;
    });

    for (const ev of upcoming) {
      await getMessaging().send({
        token,
        notification: {
          title: `📅 ${ev.title}`,
          body: `Empieza en 15 minutos — ${ev.start}`,
        },
        webpush: {
          fcmOptions: {link: "/organizador/"},
          notification: {
            icon: "/organizador/icons/icon-192.png",
            badge: "/organizador/icons/icon-192.png",
          },
        },
        data: {eventId: String(ev.id)},
      }).catch((err) => {
        // Token inválido → borrarlo
        if (err.code === "messaging/registration-token-not-registered") {
          db.collection("fcm_tokens").doc(uid).delete();
        }
      });
    }
  }
});
