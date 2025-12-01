import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-6">
      {/* Hero Section */}
      <div className="text-center max-w-2xl">
        <h1 className="text-5xl md:text-6xl font-bold text-text-000 mb-4">
          Welcome to <span className="text-accent-main-100">Radium</span>
        </h1>
        <p className="text-xl md:text-2xl text-text-300 mb-12">
          An All-In-One Interface for AI
        </p>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/models"
            className="px-8 py-3 rounded-lg border border-border-300 text-text-100 hover:bg-bg-200 transition-colors font-medium"
          >
            Browse Models
          </Link>
          <Link
            href="/chat"
            className="px-8 py-3 rounded-lg bg-accent-main-100 text-text-000 hover:bg-accent-main-200 transition-colors font-medium"
          >
            Open Chatroom
          </Link>
        </div>
      </div>
    </main>
  );
}
