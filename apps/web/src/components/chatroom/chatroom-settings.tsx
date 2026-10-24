import { BotIcon, SlidersHorizontalIcon, WrenchIcon } from "lucide-react";

/**
 * Chatroom settings pages served by `/chatroom/$section`. Drives route validation and the
 * Settings sidebar entries (labels and icons); each section renders its own panel.
 */
export const chatroomSections = [
  { value: "workers", label: "Workers", icon: BotIcon },
  { value: "preferences", label: "Chat defaults", icon: SlidersHorizontalIcon },
  { value: "tools", label: "Tools", icon: WrenchIcon },
] as const;

export type ChatroomSection = (typeof chatroomSections)[number]["value"];
