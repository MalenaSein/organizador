const {onSchedule} = require("firebase-functions/v2/scheduler");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

exports.checkUpcomingEvents = onSchedule("every 15 minutes", async () => {
  // Hora actual en Argentina (UTC-3)
  const now = new Date();
  const argNow = new Date(now.getTime() + (-3 * 60) * 60 * 1000);

  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  const fmtTime = (d) =>
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

  // Ventana: 13 a 18 minutos desde ahora (cubre delay + evita duplicados)
  const windowStart = new Date(argNow.getTime() + 13 * 60 * 1000);
  const windowEnd = new Date(argNow.getTime() + 18 * 60 * 1000);

  const dateStr = fmtDate(windowStart);
  const timeStart = fmtTime(windowStart);
  const timeEnd = fmtTime(windowEnd);

  console.log(
      `Buscando: fecha=${dateStr} entre ${timeStart}-${timeEnd} ARG`,
  );

  const tokensSnap = await db.collection("fcm_tokens").get();
  console.log(`Tokens: ${tokensSnap.size}`);

  for (const tokenDoc of tokensSnap.docs) {
    const uid = tokenDoc.id;
    const token = tokenDoc.data().token;
    if (!token) continue;

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) continue;

    const {events = []} = userSnap.data();

    const upcoming = events.filter((ev) => {
      if (!ev.date || !ev.start) return false;
      const start = ev.start.includes(":")
        ? ev.start.split(":").map((p) => p.padStart(2, "0")).join(":")
        : ev.start;
      const match = ev.date === dateStr &&
        start >= timeStart && start <= timeEnd;
      if (match) console.log(`Encontrado: "${ev.title}" ${ev.start}`);
      return match;
    });

    console.log(`uid=${uid}: ${upcoming.length} proximos`);

    for (const ev of upcoming) {
      try {
        await getMessaging().send({
          token,
          notification: {
            title: `📅 ${ev.title}`,
            body: `Empieza en 15 minutos — ${ev.start}`,
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
        console.log(`Enviada: "${ev.title}" uid=${uid}`);
      } catch (err) {
        console.error(`Error uid=${uid}: ${err.message}`);
        if (err.code === "messaging/registration-token-not-registered") {
          await db.collection("fcm_tokens").doc(uid).delete();
        }
      }
    }
  }
});