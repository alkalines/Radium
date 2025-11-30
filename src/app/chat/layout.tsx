import type { Metadata } from "next";
import "@/app/globals.css";
import { tiemposHeadline, styreneA, styreneB, claudeResponse } from "../fonts";
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
      className={`h-screen antialiased scroll-smooth ${tiemposHeadline.variable} ${styreneA.variable} ${styreneB.variable} ${claudeResponse.variable}`}
      data-theme="claude"
      data-mode="dark"
    >
      <div className="bg-bg-100 text-text-100 font-ui min-h-screen">
        <SidebarProvider>
          <ModelProvider>{children}</ModelProvider>
        </SidebarProvider>
      </div>
    </div>
  );
}
