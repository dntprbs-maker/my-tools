/* Firebase Cloud Messaging 백그라운드 수신용 서비스 워커.
   public/ 에 두면 빌드 시 그대로 루트 경로로 서빙된다.
   (Firebase config는 비밀값이 아니므로 하드코딩) */
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBT04TVP4G12K3v_6IoPppGXY9_sZa6Zxk",
  authDomain: "clean-member.firebaseapp.com",
  projectId: "clean-member",
  storageBucket: "clean-member.firebasestorage.app",
  messagingSenderId: "998957947167",
  appId: "1:998957947167:web:28563a9dfa2bcf8d92b82a",
});

const messaging = firebase.messaging();

// 백그라운드(앱이 꺼져있거나 다른 탭일 때) 알림 수신
// data-only 메시지이므로 payload.data에서 제목/본문을 읽는다 (중복 표시 방지)
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = d.title || "클린멤버";
  const options = {
    body: d.body || "",
    icon: "/logo-512.png",
    tag: d.eventId || undefined,
    data: d,
  };
  self.registration.showNotification(title, options);
});

// 알림 클릭 시 앱 열기
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url && "focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});
