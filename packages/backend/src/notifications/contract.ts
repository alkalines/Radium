import { v, type Infer } from "convex/values";
import type { LimitEventKind } from "../limits/events";

/**
 * Notification contract shared by the backend producers (Chatroom run ends, limit events), the
 * delivery channels (open browser tabs, Web Push, and a planned Expo app), and the web client.
 *
 * This module must not import `src/limits/events.ts` at runtime: `recordLimitEvent` notifies
 * through `notify.ts`, which imports this file, so a value import would form a module cycle.
 */

/** How a Chatroom request ended, from the requesting user's point of view. */
export const sessionNotificationKindValidator = v.union(
  v.literal("session_finished"),
  v.literal("session_approval"),
  v.literal("session_question"),
  v.literal("session_failed"),
);
export type SessionNotificationKind = Infer<typeof sessionNotificationKindValidator>;

/** Every notification kind: session outcomes plus every limit event kind. */
export type NotificationKind = SessionNotificationKind | LimitEventKind;

/**
 * User-facing groups that preferences switch on and off. `attention` covers a run that stopped
 * to wait for the user (tool approval, question).
 */
export const notificationCategoryValidator = v.union(
  v.literal("finished"),
  v.literal("attention"),
  v.literal("failed"),
  v.literal("limits"),
);
export type NotificationCategory = Infer<typeof notificationCategoryValidator>;

export const notificationCategories: readonly NotificationCategory[] = [
  "finished",
  "attention",
  "failed",
  "limits",
];

const categoryPreferenceValidator = v.object({
  /** Create notifications of this category at all (every channel). */
  enabled: v.boolean(),
  /** Play the category's sound in the open tab that receives it. */
  sound: v.boolean(),
});
export type CategoryPreference = Infer<typeof categoryPreferenceValidator>;

/** Stored per user in `user_preferences.notifications`; absent categories use the defaults. */
export const notificationPreferencesValidator = v.object({
  finished: v.optional(categoryPreferenceValidator),
  attention: v.optional(categoryPreferenceValidator),
  failed: v.optional(categoryPreferenceValidator),
  limits: v.optional(categoryPreferenceValidator),
});
export type StoredNotificationPreferences = Infer<typeof notificationPreferencesValidator>;

export const resolvedNotificationPreferencesValidator = v.object({
  finished: categoryPreferenceValidator,
  attention: categoryPreferenceValidator,
  failed: categoryPreferenceValidator,
  limits: categoryPreferenceValidator,
});
export type NotificationPreferences = Infer<typeof resolvedNotificationPreferencesValidator>;

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

/**
 * App-relative path a notification opens: its session, or Gateway > Limits for limit events.
 * The client switches to the notification's workspace before opening a workspace page.
 */
export function notificationPath(notification: { chat?: string }): string {
  return notification.chat ? `/chat/${notification.chat}` : "/gateway/limits";
}
