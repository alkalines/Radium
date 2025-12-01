import { Navbar } from "@/components/navigation/Navbar";

export default function GatewayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-000 relative overflow-hidden">
      {/* Background gradient - bottom left organic glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse 150% 100% at -20% 120%, rgba(198, 97, 63, 0.15) 0%, transparent 60%)
          `,
        }}
      />
      <Navbar />
      <main className="relative pt-16">{children}</main>
    </div>
  );
}
