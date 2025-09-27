"use client";

import { useState } from "react";

// Minimal inline SVG icons to avoid extra deps
const Icon = {
  Plus: (props: React.SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Settings2: (props: React.SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="2" /><circle cx="7" cy="7" r="2" />
    </svg>
  ),
  ChevronDown: (props: React.SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  Upload: (props: React.SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5-5 5 5" />
      <path d="M12 15V5" />
    </svg>
  ),
  User: (props: React.SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 21a8 8 0 1 0-16 0" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
};

export default function Home() {
  const [model] = useState("Model Name Here");

  return (
    <div className="min-h-screen grid grid-cols-[260px_1fr] text-foreground">
      {/* Sidebar */}
      <aside className="relative min-h-screen flex flex-col border-r border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-sm">
        <div className="h-14 flex items-center px-4 text-xl font-semibold tracking-tight">
          <span className="text-[var(--ivory-light)]">Claude</span>
        </div>

        <div className="px-3 py-2">
          <button className="w-full flex items-center gap-2 rounded-lg bg-[var(--surface)] hover:bg-[var(--slate-light)] transition-colors px-3 py-2 text-sm shadow-soft">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--accent)]/90 text-black">
              <Icon.Plus className="h-4 w-4" />
            </span>
            <span>New chat</span>
          </button>
        </div>

        <nav className="px-3 py-1 space-y-1 text-[0.9rem]">
          <a className="block px-3 py-2 rounded-md hover:bg-[var(--surface)]" href="#">Chats</a>
          <a className="block px-3 py-2 rounded-md hover:bg-[var(--surface)]" href="#">Projects</a>
        </nav>

        <div className="px-3 pt-4 text-[0.75rem] uppercase tracking-wider text-[var(--color-muted)]">Recents</div>
        <div className="px-3 py-2 text-sm text-[var(--color-muted)]">Some of the chats here</div>

        <div className="mt-auto" />

        {/* Footer user */}
        <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-[var(--slate-light)] grid place-items-center text-xs">AR</div>
            <div className="leading-tight">
              <div className="text-sm">User name</div>
              <div className="text-[0.75rem] text-[var(--color-muted)]">Admin</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="relative min-h-screen bg-[var(--background)]">
        {/* top-right avatar */}
        <div className="h-14 flex items-center justify-end px-6">
          <div className="h-6 w-6 rounded-full bg-black/60 grid place-items-center border border-[var(--border)]">
            <Icon.User className="h-4 w-4 text-[var(--color-muted)]" />
          </div>
        </div>

        {/* Center hero */}
        <section className="mx-auto max-w-4xl pt-16 pb-24 px-6 text-center">
          <div className="text-[2.25rem] sm:text-[3rem] md:text-[3.25rem] font-semibold tracking-tight">
            <span className="align-middle mr-2" role="img" aria-label="spark">✴️</span>
            <span className="text-[var(--ivory-light)]">What’s new, User?</span>
          </div>

          {/* Input card */}
          <div className="mt-10 mx-auto max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)]/95 shadow-soft">
            <div className="flex items-center gap-3 px-4 py-3">
              <button className="h-8 w-8 grid place-items-center rounded-md bg-[var(--slate-light)]/60 hover:bg-[var(--slate-light)] transition-colors">
                <Icon.Plus className="h-4 w-4 text-[var(--ivory-light)]" />
              </button>
              <button className="h-8 w-8 grid place-items-center rounded-md bg-[var(--slate-light)]/60 hover:bg-[var(--slate-light)] transition-colors">
                <Icon.Settings2 className="h-4 w-4 text-[var(--ivory-light)]" />
              </button>

              <input
                className="flex-1 bg-transparent outline-none text-[var(--ivory-light)] placeholder:text-[var(--color-muted)] px-1"
                placeholder="How can I help you today?"
              />

              {/* Model selector */}
              <button className="hidden sm:flex items-center gap-1 text-sm text-[var(--color-muted)] hover:text-[var(--ivory-light)] transition-colors">
                {model}
                <Icon.ChevronDown className="h-4 w-4" />
              </button>

              {/* Upload / send */}
              <button
                className="h-8 w-8 grid place-items-center rounded-md bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-black transition-colors"
                aria-label="Upload"
              >
                <Icon.Upload className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
