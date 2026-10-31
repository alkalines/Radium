import type { FunctionReturnType } from "convex/server";
import {
  CircleCheckIcon,
  GaugeIcon,
  MessageCircleQuestionIcon,
  OctagonXIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import type { api } from "backend/convex/_generated/api";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

type NotificationView = FunctionReturnType<typeof api.notifications.recent>[number];

/** What a notification toast shows; `_id` also dedupes the toast. */
export type NotificationToastContent = Pick<
  NotificationView,
  "kind" | "category" | "title" | "body"
> & { _id: string };

/** Sonner toaster that only renders notifications, so app feedback toasts keep their place. */
const NOTIFICATION_TOASTER = "notifications";
const TOAST_DURATION_MS = 8_000;

/** The notifications Toaster: top right, newest on top, the pile expanded. */
export function NotificationToaster() {
  return (
    <Toaster
      id={NOTIFICATION_TOASTER}
      position="top-right"
      expand
      visibleToasts={5}
      duration={TOAST_DURATION_MS}
      className="notification-toaster"
    />
  );
}

/**
 * Show one notification as a card toast. With `onOpen`, clicking the card opens its target and
 * dismisses it; the corner X (or a swipe) only dismisses.
 */
export function showNotificationToast(notification: NotificationToastContent, onOpen?: () => void) {
  toast.custom(
    (toastId) => (
      <NotificationCard
        notification={notification}
        onOpen={onOpen}
        onDismiss={() => toast.dismiss(toastId)}
      />
    ),
    { toasterId: NOTIFICATION_TOASTER, id: notification._id },
  );
}

function NotificationIcon({ notification }: { notification: NotificationToastContent }) {
  if (notification.kind === "session_approval") {
    return <ShieldAlertIcon className="size-[18px] text-signal-awaiting" />;
  }
  if (notification.kind === "session_question") {
    return <MessageCircleQuestionIcon className="size-[18px] text-signal-awaiting" />;
  }
  if (notification.category === "finished") {
    return <CircleCheckIcon className="size-[18px] text-signal-success" />;
  }
  if (notification.category === "failed") {
    return <OctagonXIcon className="size-[18px] text-destructive" />;
  }
  return <GaugeIcon className="size-[18px] text-muted-foreground" />;
}

/**
 * Notification card in the system-notification shape: a round card with the category tile, the
 * title, and up to two lines of body. The dismiss X sits on the top-left corner and shows on
 * hover or keyboard focus (always on touch screens).
 */
function NotificationCard({
  notification,
  onOpen,
  onDismiss,
}: {
  notification: NotificationToastContent;
  onOpen?: () => void;
  onDismiss: () => void;
}) {
  const content = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-tag">
        <NotificationIcon notification={notification} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <span className="truncate text-[13px] font-medium">{notification.title}</span>
        <span className="line-clamp-2 text-[13px] text-muted-foreground">{notification.body}</span>
      </span>
    </>
  );
  // The card floats over arbitrary Panel content, like shadcn popovers, so it keeps a shadow
  // (docs/Interface_Design.md §3.2 allows popover shadows; sonner's own toasts carry one too).
  const cardClassName =
    "flex w-full items-start gap-3 rounded-[20px] border bg-popover p-3 pr-4 text-left text-popover-foreground shadow-lg";

  return (
    <div data-slot="notification-card" className="group/notification relative w-(--width)">
      {onOpen ? (
        <button
          type="button"
          className={cn(
            cardClassName,
            "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          )}
          onClick={() => {
            onOpen();
            onDismiss();
          }}
        >
          {content}
        </button>
      ) : (
        <div className={cardClassName}>{content}</div>
      )}

      <button
        type="button"
        aria-label="Dismiss notification"
        className="absolute -top-1.5 -left-1.5 flex size-5 items-center justify-center rounded-full border bg-popover text-muted-foreground opacity-0 transition-opacity outline-none group-focus-within/notification:opacity-100 group-hover/notification:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [@media(hover:none)]:opacity-100"
        onClick={onDismiss}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
