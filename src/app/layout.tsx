import { AuthProvider } from "@/components/providers/AuthProvider";
import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";

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
