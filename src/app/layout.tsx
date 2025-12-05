import { AuthProvider } from "@/components/providers/AuthProvider";
import { ConvexClientProvider } from "../components/providers/ConvexClientProvider";
import "./globals.css";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Radium",
  description: "An All-In-One solution for AI use cases.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html className="dark">
      <body className="bg-bg-000 text-text-100 antialiased">
        <ConvexClientProvider>
          <AuthProvider>{children}</AuthProvider>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
