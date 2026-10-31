/**
 * Radium notification service worker (registered by
 * `src/components/notifications/browser-notifications.ts`). It only handles notifications: no
 * fetch handler, no caching.
 *
 * - `push`: Web Push from `packages/backend/src/notifications/web-push.ts`, sent only when no open
 *   tab claimed the notification. Payload: `{ id, kind, category, title, body, path, workspace? }`.
 * - `notificationclick`: focuses an open Radium window and tells it what to open, or opens a new
 *   window at the notification's path.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload.title !== "string") return;

  // The tag matches the one an open tab uses, so the same notification never shows twice.
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === "string" ? payload.body : "",
      tag: String(payload.id),
      data: { path: payload.path, workspace: payload.workspace },
    }),
  );
});

/** The notification's path when it resolves to this origin, else `/` (blocks `//host` redirects). */
function sameOriginPath(value) {
  if (typeof value !== "string") return "/";
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin === self.location.origin) return url.pathname + url.search + url.hash;
  } catch {
    // Unparseable paths fall through to the root.
  }
  return "/";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const path = sameOriginPath(data.path);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const sameOrigin = windows.filter(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      const target = sameOrigin.find((client) => client.focused) || sameOrigin[0];
      if (target) {
        await target.focus();
        target.postMessage({ type: "radium:notification-open", path, workspace: data.workspace });
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});
