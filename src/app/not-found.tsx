import Link from "next/link";
import { Navbar } from "@/components/navigation/Navbar";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg-000">
      <Navbar />
      <div className="flex items-center justify-center px-4 pt-32">
        <div className="text-center">
          {/* 404 Illustration */}
          <div className="relative mb-8">
            <div className="text-[150px] md:text-[200px] font-bold text-bg-200 leading-none select-none">
              404
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-24 h-24 rounded-full bg-accent-main-100/20 flex items-center justify-center">
                <span className="text-4xl">🔍</span>
              </div>
            </div>
          </div>

          {/* Message */}
          <h1 className="text-3xl md:text-4xl font-bold text-text-100 mb-4">
            Page Not Found
          </h1>
          <p className="text-lg text-text-500 max-w-md mx-auto mb-8">
            Sorry, we couldn&apos;t find the page you&apos;re looking for. It
            might have been moved or doesn&apos;t exist.
          </p>

          {/* Actions */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-lg bg-accent-main-100 px-6 py-3 text-base font-medium text-white transition-all hover:bg-accent-main-200 hover:scale-105 active:scale-95"
            >
              Go Home
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center justify-center rounded-lg border border-border-200 bg-bg-100 px-6 py-3 text-base font-medium text-text-100 transition-all hover:bg-bg-200"
            >
              View Docs
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
