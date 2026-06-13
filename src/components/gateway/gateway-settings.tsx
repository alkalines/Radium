import { Link } from "@tanstack/react-router";
import { CreditCardIcon, KeyRoundIcon, KeySquareIcon, RouteIcon, type LucideIcon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProvidersPanel } from "./providers-panel";
import { CredentialsPanel } from "./credentials-panel";

export const gatewaySections = [
  { value: "providers", label: "Providers", icon: RouteIcon },
  { value: "credentials", label: "Credentials", icon: KeyRoundIcon },
  { value: "keys", label: "API Keys", icon: KeySquareIcon },
  { value: "credits", label: "Credits", icon: CreditCardIcon },
] as const;

export type GatewaySection = (typeof gatewaySections)[number]["value"];

export function GatewaySettings({ section }: { section: GatewaySection }) {
  return (
    <Tabs value={section} className="w-full gap-4 md:gap-6">
      <TabsList aria-label="Gateway settings">
        {gatewaySections.map((entry) => (
          <TabsTrigger key={entry.value} value={entry.value} asChild>
            <Link
              to="/gateway/$section"
              params={{ section: entry.value }}
              className="gap-1.5"
            >
              <entry.icon className="text-muted-foreground" />
              {entry.label}
            </Link>
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="providers" tabIndex={-1}>
        {section === "providers" && <ProvidersPanel />}
      </TabsContent>

      <TabsContent value="credentials" tabIndex={-1}>
        {section === "credentials" && <CredentialsPanel />}
      </TabsContent>

      <TabsContent value="keys" tabIndex={-1}>
        {section === "keys" && (
          <ComingSoon
            icon={KeySquareIcon}
            title="API keys"
            description="Issue and manage keys for calling models through the Radium Gateway."
          />
        )}
      </TabsContent>

      <TabsContent value="credits" tabIndex={-1}>
        {section === "credits" && (
          <ComingSoon
            icon={CreditCardIcon}
            title="Credits"
            description="Top up and track gateway credit usage across your balances."
          />
        )}
      </TabsContent>
    </Tabs>
  );
}

function ComingSoon({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description} Coming soon.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
