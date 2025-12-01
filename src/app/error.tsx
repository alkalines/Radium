"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen bg-bg-000 flex items-center justify-center px-4">
      <div className="text-center">
        {/* Error Illustration */}
        <div className="relative mb-8">
          <div className="w-24 h-24 mx-auto rounded-full bg-red-500/20 flex items-center justify-center">
            <span className="text-4xl">⚠️</span>
          </div>
        </div>

        {/* Message */}
        <h1 className="text-3xl md:text-4xl font-bold text-text-100 mb-4">
          Something Went Wrong
        </h1>
        <p className="text-lg text-text-500 max-w-md mx-auto mb-8">
          An error occurred while loading this page. Please try again.
        </p>

        {/* Error Digest */}
        {error.digest && (
          <p className="text-sm text-text-500 mb-6 font-mono">
            Error ID: {error.digest}
          </p>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            onClick={reset}
            className="inline-flex items-center justify-center rounded-lg bg-accent-main-100 px-6 py-3 text-base font-medium text-white transition-all hover:bg-accent-main-200 hover:scale-105 active:scale-95"
          >
            Try Again
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg border border-border-200 bg-bg-100 px-6 py-3 text-base font-medium text-text-100 transition-all hover:bg-bg-200"
          >
            Go Home
          </Link>
        </div>
      </div>
    </div>
  );
}
