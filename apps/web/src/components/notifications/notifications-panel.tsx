import { useEffect, useState, type ReactNode } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  BellRingIcon,
  CircleCheckIcon,
  GaugeIcon,
  MonitorIcon,
  OctagonXIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { NotificationCategory } from "backend/src/notifications/contract";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { PageHeader } from "@/components/harness/page-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  currentPushSubscription,
  isPushSupported,
  notificationPermission,
  pushSubscriptionFields,
  showSystemNotification,
  subscribeToPush,
  type NotificationPermissionState,
} from "./browser-notifications";
import { showNotificationToast } from "./notification-center";
import { playNotificationSound } from "./notification-sounds";

const categories: {
  category: NotificationCategory;
  icon: LucideIcon;
  title: string;
  description: string;
}[] = [
  {
    category: "finished",
    icon: CircleCheckIcon,
    title: "Session finished",
    description: "A run you started completed.",
  },
  {
    category: "attention",
    icon: ShieldAlertIcon,
    title: "Needs your attention",
    description: "A run waits for a tool approval or an answer to its question.",
  },
  {
    category: "failed",
    icon: OctagonXIcon,
    title: "Session failed",
    description: "A run you started stopped with an error.",
  },
  {
    category: "limits",
    icon: GaugeIcon,
    title: "Usage limits",
    description: "Credentials in workspaces you own run low, run out, reset, or are rejected.",
  },
];

function permissionDescription(permission: NotificationPermissionState, canPush: boolean) {
  if (permission === "unsupported") return "This browser cannot show system notifications.";
  if (permission === "denied") {
    return "Blocked for this site. Allow notifications in the browser's site settings.";
  }
  if (permission === "default") {
    return "Off. Enable to get system notifications while Radium is in the background.";
  }
  return canPush
    ? "On, including while every Radium tab is closed."
    : "On while a Radium tab is open in the background.";
}

/**
 * Settings → Account → Notifications. Account-level choices (`api.notifications.getPreferences`)
 * decide which categories notify and which sound; this device's row asks for the browser
 * permission and, when the deployment has VAPID keys, subscribes it to Web Push so notifications
 * arrive with every tab closed. The device list shows every subscribed browser; the Expo app row
 * is a placeholder until a phone app exists.
 */
export function NotificationsPanel() {
  const { data: preferences } = useQuery(convexQuery(api.notifications.getPreferences, {}));
  const { data: pushConfig } = useQuery(convexQuery(api.notifications.pushConfig, {}));
  const setPreference = useMutation(api.notifications.setPreference);
  const subscribe = useMutation(api.notifications.subscribe);
  const unsubscribe = useMutation(api.notifications.unsubscribe);

  // Browser state is client-only; read it after mount so server and client markup agree.
  const [permission, setPermission] = useState<NotificationPermissionState>("unsupported");
  const [endpoint, setEndpoint] = useState<string | undefined>();
  const [isBusy, setIsBusy] = useState(false);
  useEffect(() => {
    setPermission(notificationPermission());
    void currentPushSubscription().then((subscription) => setEndpoint(subscription?.endpoint));
  }, []);

  const { data: devices } = useQuery(
    convexQuery(api.notifications.listDevices, endpoint ? { endpoint } : {}),
  );

  const publicKey = pushConfig?.publicKey ?? null;
  const canPush = publicKey !== null && isPushSupported();
  const isSubscribed = endpoint !== undefined && Boolean(devices?.some((device) => device.current));

  async function enable() {
    setIsBusy(true);
    try {
      const next = await Notification.requestPermission();
      setPermission(next);
      if (next !== "granted" || !publicKey || !isPushSupported()) return;

      const subscription = await subscribeToPush(publicKey);
      await subscribe(pushSubscriptionFields(subscription));
      setEndpoint(subscription.endpoint);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not enable notifications.");
    } finally {
      setIsBusy(false);
    }
  }

  async function disablePush() {
    setIsBusy(true);
    try {
      const subscription = await currentPushSubscription();
      if (subscription) {
        await unsubscribe({ endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setEndpoint(undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not turn off push.");
    } finally {
      setIsBusy(false);
    }
  }

  async function removeDevice(device: NonNullable<typeof devices>[number]) {
    try {
      if (device.current) {
        await disablePush();
        return;
      }
      await unsubscribe({ device: device._id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the device.");
    }
  }

  // Exercises this device's channels locally (no server round trip): the toast, the attention
  // sound, and the system notification, so the user can check volume and permissions.
  function sendTest() {
    const test = {
      _id: `test-${Date.now()}`,
      kind: "session_approval" as const,
      category: "attention" as const,
      title: "Test notification",
      body: "This is how Radium notifications look and sound on this device.",
    };
    showNotificationToast(test);
    playNotificationSound(test.category);
    void showSystemNotification({ ...test, id: test._id, path: "/settings/notifications" });
  }

  let deviceAction: ReactNode = null;
  if (permission === "default" || (permission === "granted" && canPush && !isSubscribed)) {
    deviceAction = (
      <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void enable()}>
        {permission === "default" ? "Enable" : "Enable push"}
      </Button>
    );
  } else if (permission === "granted" && isSubscribed) {
    deviceAction = (
      <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void disablePush()}>
        Turn off push
      </Button>
    );
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Radium tells you when a session finishes, needs you, or fails, and when usage limits change. An open tab shows a toast and plays the sound; if no tab is open, your subscribed devices get a push notification instead, so nothing rings twice."
      />

      <GroupList title="This device">
        <Row
          icon={MonitorIcon}
          title="System notifications"
          description={permissionDescription(permission, canPush && isSubscribed)}
        >
          {deviceAction}
        </Row>
        {permission === "granted" && pushConfig !== undefined && publicKey === null ? (
          <RowBlock className="text-sm text-muted-foreground">
            Push while Radium is closed is not configured on this server (Web Push VAPID keys).
          </RowBlock>
        ) : null}
        <Row
          icon={BellRingIcon}
          title="Test"
          description="Show a toast, play a sound, and send a system notification here."
        >
          <Button variant="outline" size="sm" onClick={sendTest}>
            Send test
          </Button>
        </Row>
      </GroupList>

      <GroupList title="Notify me about">
        {preferences === undefined ? (
          <RowBlock aria-busy="true">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </RowBlock>
        ) : (
          categories.map((item) => {
            const current = preferences[item.category];
            const enabledId = `notify-${item.category}`;
            const soundId = `notify-${item.category}-sound`;
            const save = (next: { enabled: boolean; sound: boolean }) =>
              void setPreference({ category: item.category, ...next }).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : "Could not save."),
              );

            return (
              <Row
                key={item.category}
                icon={item.icon}
                title={item.title}
                description={item.description}
              >
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={soundId} className="text-xs font-normal text-muted-foreground">
                      Sound
                    </Label>
                    <Switch
                      id={soundId}
                      checked={current.enabled && current.sound}
                      disabled={!current.enabled}
                      aria-label={`Play a sound for ${item.title}`}
                      onCheckedChange={(sound) => save({ enabled: current.enabled, sound })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor={enabledId}
                      className="text-xs font-normal text-muted-foreground"
                    >
                      Notify
                    </Label>
                    <Switch
                      id={enabledId}
                      checked={current.enabled}
                      aria-label={`Notify about ${item.title}`}
                      onCheckedChange={(enabled) => save({ enabled, sound: current.sound })}
                    />
                  </div>
                </div>
              </Row>
            );
          })
        )}
      </GroupList>

      <GroupList title="Push devices">
        {devices?.length === 0 ? (
          <RowBlock className="text-sm text-muted-foreground">
            No browser receives push notifications yet.
          </RowBlock>
        ) : null}
        {devices?.map((device) => (
          <Row
            key={device._id}
            icon={MonitorIcon}
            title={device.label}
            tag={device.current ? "This device" : undefined}
            description={
              device.lastDeliveredAt
                ? `Last notified ${formatDistanceToNowStrict(device.lastDeliveredAt, { addSuffix: true })}`
                : `Added ${formatDistanceToNowStrict(device.createdAt, { addSuffix: true })}`
            }
          >
            <Button variant="outline" size="sm" onClick={() => void removeDevice(device)}>
              Remove
            </Button>
          </Row>
        ))}
        {/* Planned: the Expo app registers the phone; it is notified before desktop push. */}
        <Row
          icon={SmartphoneIcon}
          title="Radium mobile app"
          tag="Planned"
          description="Phones will be notified when no tab is open, before desktop push."
        />
      </GroupList>
    </>
  );
}
