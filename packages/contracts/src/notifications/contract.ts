import { z } from "zod";
import type { LimitEventKind } from "../limits/events";

/**
 * Notification contract shared by the backend producers (Chatroom run ends, limit events), the
 * delivery channels (open browser tabs, Web Push, and a planned Expo app), and the web client.
 */

/** How a Chatroom request ended, from the requesting user's point of view. */
export const sessionNotificationKindValidator = z.union([
  z.literal("session_finished"),
  z.literal("session_approval"),
  z.literal("session_question"),
  z.literal("session_failed"),
]);
export type SessionNotificationKind = z.infer<typeof sessionNotificationKindValidator>;

/** Every notification kind: session outcomes plus every limit event kind. */
export type NotificationKind = SessionNotificationKind | LimitEventKind;

/**
 * User-facing groups that preferences switch on and off. `attention` covers a run that stopped
 * to wait for the user (tool approval, question).
 */
export const notificationCategoryValidator = z.union([
  z.literal("finished"),
  z.literal("attention"),
  z.literal("failed"),
  z.literal("limits"),
]);
export type NotificationCategory = z.infer<typeof notificationCategoryValidator>;

export const notificationCategories: readonly NotificationCategory[] = [
  "finished",
  "attention",
  "failed",
  "limits",
];

const categoryPreferenceValidator = z.object({
  /** Create notifications of this category at all (every channel). */
  enabled: z.boolean(),
  /** Play the category's sound in the open tab that receives it. */
  sound: z.boolean(),
});
export type CategoryPreference = z.infer<typeof categoryPreferenceValidator>;

/** Stored per user in `user_preferences.notifications`; absent categories use the defaults. */
export const notificationPreferencesValidator = z.object({
  finished: z.optional(categoryPreferenceValidator),
  attention: z.optional(categoryPreferenceValidator),
  failed: z.optional(categoryPreferenceValidator),
  limits: z.optional(categoryPreferenceValidator),
});
export type StoredNotificationPreferences = z.infer<typeof notificationPreferencesValidator>;

export const resolvedNotificationPreferencesValidator = z.object({
  finished: categoryPreferenceValidator,
  attention: categoryPreferenceValidator,
  failed: categoryPreferenceValidator,
  limits: categoryPreferenceValidator,
});
export type NotificationPreferences = z.infer<typeof resolvedNotificationPreferencesValidator>;

// Session outcomes need the user to come back, so they sound by default; limit events are
// owner housekeeping and only show.
const defaultPreferences: NotificationPreferences = {
  finished: { enabled: true, sound: true },
  attention: { enabled: true, sound: true },
  failed: { enabled: true, sound: true },
  limits: { enabled: true, sound: false },
};

export function resolveNotificationPreferences(
  stored: StoredNotificationPreferences | undefined,
): NotificationPreferences {
  return {
    finished: stored?.finished ?? defaultPreferences.finished,
    attention: stored?.attention ?? defaultPreferences.attention,
    failed: stored?.failed ?? defaultPreferences.failed,
    limits: stored?.limits ?? defaultPreferences.limits,
  };
}

export function notificationCategory(kind: NotificationKind): NotificationCategory {
  switch (kind) {
    case "session_finished":
      return "finished";
    case "session_approval":
    case "session_question":
      return "attention";
    case "session_failed":
      return "failed";
    default:
      return "limits";
  }
}

/** Short headline for a notification; the body carries the specifics. */
export function notificationTitle(kind: NotificationKind): string {
  switch (kind) {
    case "session_finished":
      return "Session finished";
    case "session_approval":
      return "Approval needed";
    case "session_question":
      return "Question waiting";
    case "session_failed":
      return "Session failed";
    case "limit_low":
      return "Usage limit low";
    case "limit_critical":
      return "Usage limit almost reached";
    case "limit_exhausted":
      return "Usage limit reached";
    case "limit_reset":
      return "Usage limit reset";
    case "credential_expired":
      return "Credential rejected";
    case "credential_restored":
      return "Credential restored";
    case "poll_failed":
      return "Usage check failed";
  }
}

/** Authenticates a sealed notification to its recipient, workspace and database row. */
export function notificationAad(userId: string, workspace: string | undefined, id: string) {
  return {
    table: "notifications",
    workspace: workspace ?? "",
    parent: userId,
    record: id,
    field: "content",
  };
}

/**
 * App-relative path a notification opens: its session, or Gateway > Limits for limit events.
 * The client switches to the notification's workspace before opening a workspace page.
 */
export function notificationPath(notification: { chat?: string }): string {
  return notification.chat ? `/chat/${notification.chat}` : "/gateway/limits";
}

/** Sealed body of a limit notification: credential, provider and meter, each bounded. */
export function limitNotificationBody(parts: {
  credential: string;
  provider: string;
  meter?: string;
}): string {
  const meter = parts.meter ? ` · ${parts.meter.slice(0, 80)}` : "";
  return `${parts.credential.slice(0, 80)} · ${parts.provider.slice(0, 80)}${meter}`;
}
