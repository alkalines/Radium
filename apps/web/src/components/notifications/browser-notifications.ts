import Bowser from "bowser";

/**
 * Browser plumbing for notifications: permission, the notification service worker, system
 * notifications from an open tab, and this browser's Web Push subscription. Every function is a
 * no-op (or reports `unsupported`) during SSR and in browsers without the API.
 */

const SERVICE_WORKER_URL = "/notifications-sw.js";

/** Message the service worker posts to an open window when a system notification is clicked. */
export const NOTIFICATION_OPEN_MESSAGE = "radium:notification-open";

export type NotificationPermissionState = NotificationPermission | "unsupported";

export function notificationPermission(): NotificationPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Web Push additionally needs a service worker and the Push API (Safari: installed web app). */
export function isPushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    window.isSecureContext
  );
}

let registration: Promise<ServiceWorkerRegistration | undefined> | undefined;

/** Register the notification service worker once per page; `undefined` where unavailable. */
export function notificationWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) {
    return Promise.resolve(undefined);
  }
  registration ??= navigator.serviceWorker
    .register(SERVICE_WORKER_URL, { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => undefined);
  return registration;
}

/**
 * Show a system notification from this tab. Goes through the service worker when there is one,
 * so a click is handled the same way as a pushed notification and the shared `tag` replaces
 * rather than duplicates. `onOpen` handles clicks only for the plain `Notification` fallback.
 */
export async function showSystemNotification(
  notification: { id: string; title: string; body: string; path: string; workspace?: string },
  onOpen?: () => void,
) {
  if (notificationPermission() !== "granted") return;

  const options: NotificationOptions = {
    body: notification.body,
    tag: notification.id,
    data: { path: notification.path, workspace: notification.workspace },
  };
  const worker = await notificationWorker();
  if (worker) {
    await worker.showNotification(notification.title, options);
    return;
  }

  const shown = new Notification(notification.title, options);
  shown.onclick = () => {
    window.focus();
    onOpen?.();
    shown.close();
  };
}

/** This browser's current push subscription, if it has one. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const worker = await notificationWorker();
  return (await worker?.pushManager.getSubscription()) ?? null;
}

function applicationServerKey(base64Url: string) {
  const base64 = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** Subscribe this browser to Web Push with the deployment's VAPID public key. */
export async function subscribeToPush(publicKey: string): Promise<PushSubscription> {
  const worker = await notificationWorker();
  if (!worker) throw new Error("This browser cannot receive push notifications.");
  return await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
}

/** Endpoint and keys in the shape `api.notifications.subscribe` takes. */
export function pushSubscriptionFields(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
    label: deviceLabel(),
  };
}

/** `Firefox on Linux`, for the device list. */
function deviceLabel() {
  const parsed = Bowser.parse(navigator.userAgent);
  const browser = parsed.browser.name ?? "Browser";
  return parsed.os.name ? `${browser} on ${parsed.os.name}` : browser;
}
