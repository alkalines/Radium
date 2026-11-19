/// <reference lib="webworker" />
import { fromBase64Url } from "radium-crypto";
import { openNotification } from "./lib/crypto/notification-content";

const sw = self as unknown as ServiceWorkerGlobalScope;

function genericTitle(kind: unknown): string {
  switch (kind) {
    case "session_finished": return "Session finished";
    case "session_approval": return "Approval needed";
    case "session_question": return "Question waiting";
    case "session_failed": return "Session failed";
    default: return "Radium notification";
  }
}

sw.addEventListener("install", () => { void sw.skipWaiting(); });
sw.addEventListener("activate", (event) => { event.waitUntil(sw.clients.claim()); });
sw.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload: Record<string, unknown>;
    try { payload = event.data?.json(); } catch { return; }
    if (!payload || typeof payload.id !== "string") return;
    let title = genericTitle(payload.kind);
    let body = "";
    const sealed = payload.sealed as Record<string, unknown> | undefined;
    if (typeof payload.userId === "string" && sealed && typeof sealed.keyId === "string" &&
        typeof sealed.box === "string" && sealed.box.length <= 3500 &&
        (payload.workspace === undefined || typeof payload.workspace === "string")) {
      try {
        const bytes = fromBase64Url(sealed.box);
        const content = await openNotification({
          _id: payload.id,
          userId: payload.userId,
          workspace: payload.workspace as string | undefined,
          sealed: { keyId: sealed.keyId, box: bytes.slice().buffer },
        }, true);
        if (content) ({ title, body } = content);
      } catch {
        // Invalid, locked or stale ciphertext remains generic.
      }
    }
    await sw.registration.showNotification(title, {
      body,
      tag: payload.id,
      data: { path: payload.path, workspace: payload.workspace },
    });
  })());
});

function sameOriginPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  try {
    const url = new URL(value, sw.location.origin);
    if (url.origin === sw.location.origin) return url.pathname + url.search + url.hash;
  } catch { /* Invalid paths open home. */ }
  return "/";
}

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const path = sameOriginPath(data.path);
  event.waitUntil((async () => {
    const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    const sameOrigin = windows.filter((client) => new URL(client.url).origin === sw.location.origin);
    const target = sameOrigin.find((client) => client.focused) || sameOrigin[0];
    if (target) {
      await target.focus();
      target.postMessage({ type: "radium:notification-open", path, workspace: data.workspace });
    } else {
      await sw.clients.openWindow(path);
    }
  })());
});
