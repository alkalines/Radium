import { KeyRoundIcon, KeySquareIcon, RouteIcon, WaypointsIcon } from "lucide-react";

/**
 * Gateway settings pages served by `/gateway/$section`, which render in the 760px settings
 * column. Drives route validation and their Settings sidebar entries (labels and icons). Wide
 * pages (Activity, Logs, Telemetry) have their own routes so they can opt into `settingsWidth`.
 */
export const gatewaySections = [
  { value: "providers", label: "Providers", icon: RouteIcon },
  { value: "credentials", label: "Credentials", icon: KeyRoundIcon },
  { value: "routing", label: "Routing", icon: WaypointsIcon },
  { value: "keys", label: "API keys", icon: KeySquareIcon },
] as const;

export type GatewaySection = (typeof gatewaySections)[number]["value"];
