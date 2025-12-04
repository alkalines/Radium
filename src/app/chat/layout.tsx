import type { Metadata } from "next";
import "@/app/globals.css";
import { ss4, DMSans } from "../fonts";
import { SidebarProvider } from "@/lib/contexts/SidebarContext";
import { ModelProvider } from "@/lib/contexts/ModelContext";

export const metadata: Metadata = {
  title: "Claude",
  description: "Talk with Claude, an AI assistant from Anthropic",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      lang="pt-BR"
      className={`h-screen antialiased scroll-smooth ${ss4.variable} ${DMSans.variable}`}
      data-theme="claude"
      data-mode="dark"
    >
      <div className="bg-bg-100 text-text-100 min-h-screen">
        <SidebarProvider>
          <ModelProvider>{children}</ModelProvider>
        </SidebarProvider>
      </div>
    </div>
  );
}
