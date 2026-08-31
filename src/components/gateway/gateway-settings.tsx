import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  CreditCardIcon,
  KeyRoundIcon,
  KeySquareIcon,
  RouteIcon,
  ScrollTextIcon,
} from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProvidersPanel } from "./providers-panel";
import { CredentialsPanel } from "./credentials-panel";
import { KeysPanel } from "./keys-panel";
import { CreditsPanel } from "./credits-panel";
import { LogsPanel } from "./logs-panel";
import { ActivityPanel } from "./activity-panel";

export const gatewaySections = [
  { value: "activity", label: "Activity", icon: ActivityIcon, hidden: false },
  { value: "providers", label: "Providers", icon: RouteIcon, hidden: false },
  { value: "credentials", label: "Credentials", icon: KeyRoundIcon, hidden: false },
  { value: "keys", label: "API Keys", icon: KeySquareIcon, hidden: false },
  { value: "logs", label: "Logs", icon: ScrollTextIcon, hidden: false },
  { value: "credits", label: "Credits", icon: CreditCardIcon, hidden: true },
] as const;

export type GatewaySection = (typeof gatewaySections)[number]["value"];

export function GatewaySettings({
  section,
  hideNav,
}: {
  section: GatewaySection;
  /** When `true`, hides the top tab navigation (used when nav lives in the sidebar). */
  hideNav?: boolean;
}) {
  return (
    <Tabs value={section} className="w-full gap-4 md:gap-6">
      <TabsList aria-label="Gateway settings" className={hideNav ? "hidden" : undefined}>
        {gatewaySections
          .filter((entry) => !entry.hidden)
          .map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} asChild>
              <Link to="/gateway/$section" params={{ section: entry.value }} className="gap-1.5">
                <entry.icon className="text-muted-foreground" />
                {entry.label}
              </Link>
            </TabsTrigger>
          ))}
      </TabsList>

      <TabsContent value="providers" tabIndex={-1}>
        {section === "providers" && <ProvidersPanel />}
      </TabsContent>

      <TabsContent value="activity" tabIndex={-1}>
        {section === "activity" && <ActivityPanel />}
      </TabsContent>

      <TabsContent value="credentials" tabIndex={-1}>
        {section === "credentials" && <CredentialsPanel />}
      </TabsContent>

      <TabsContent value="keys" tabIndex={-1}>
        {section === "keys" && <KeysPanel />}
      </TabsContent>

      <TabsContent value="credits" tabIndex={-1}>
        {section === "credits" && <CreditsPanel />}
      </TabsContent>

      <TabsContent value="logs" tabIndex={-1}>
        {section === "logs" && <LogsPanel />}
      </TabsContent>
    </Tabs>
  );
}
