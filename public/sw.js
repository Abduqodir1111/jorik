/* No offline caching: authenticated conversations must not enter a public cache. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    /* Show a visible fallback. */
  }
  let url = new URL("/", self.location.origin);
  try {
    const candidate = new URL(data.url || "/", self.location.origin);
    if (candidate.origin === self.location.origin) url = candidate;
  } catch {
    /* Never open an untrusted URL. */
  }
  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" ? data.title.slice(0, 120) : "Jorik",
      {
        body:
          typeof data.body === "string"
            ? data.body.slice(0, 180)
            : "Новое сообщение",
        icon: "/push-icon-192.png",
        badge: "/push-icon-192.png",
        tag: typeof data.tag === "string" ? data.tag : undefined,
        data: { url: url.href },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL(
        event.notification.data?.url || "/",
        self.location.origin,
      );
      if (url.origin !== self.location.origin) return;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const client = windows.find(
        (w) => new URL(w.url).origin === self.location.origin,
      );
      if (client) {
        // Keep the current page and unsent drafts alive.
        client.postMessage({
          type: "OPEN_CONVERSATION",
          conversationId: url.searchParams.get("conversation"),
        });
        await client.focus();
      } else await self.clients.openWindow(url.href);
    })(),
  );
});
