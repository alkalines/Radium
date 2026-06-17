import { Link } from "@tanstack/react-router";
import { SlidersHorizontalIcon, WrenchIcon } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToolsPanel } from "./tools-panel";
import { PreferencesPanel } from "./preferences-panel";

/**
 * Chatroom settings sections. Mirrors {@link gatewaySections}: a typed array
 * that drives both the `/chatroom/$section` route and the settings sidebar.
 */
export const chatroomSections = [
  { value: "preferences", label: "Preferences", icon: SlidersHorizontalIcon },
  { value: "tools", label: "Tools", icon: WrenchIcon },
] as const;

export type ChatroomSection = (typeof chatroomSections)[number]["value"];

export function ChatroomSettings({
  section,
  hideNav,
}: {
  section: ChatroomSection;
  /** When `true`, hides the top tab navigation (used when nav lives in the sidebar). */
  hideNav?: boolean;
}) {
  return (
    <Tabs value={section} className="w-full gap-4 md:gap-6">
      <TabsList aria-label="Chatroom settings" className={hideNav ? "hidden" : undefined}>
        {chatroomSections.map((entry) => (
          <TabsTrigger key={entry.value} value={entry.value} asChild>
            <Link to="/chatroom/$section" params={{ section: entry.value }} className="gap-1.5">
              <entry.icon className="text-muted-foreground" />
              {entry.label}
            </Link>
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="preferences" tabIndex={-1}>
        {section === "preferences" && <PreferencesPanel />}
      </TabsContent>

      <TabsContent value="tools" tabIndex={-1}>
        {section === "tools" && <ToolsPanel />}
      </TabsContent>
    </Tabs>
  );
}
