"use client";

import {
  SignedIn,
  SignedOut,
  UserButton,
  AuthLoading,
} from "@daveyplate/better-auth-ui";
import Link from "next/link";
import { Logo } from "./Logo";

function AuthButtonSkeleton() {
  return (
    <div className="h-9 w-20 rounded-lg bg-bg-200 animate-pulse" />
  );
}

export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border-200 bg-bg-000/80 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Logo variant="full" href="/" />

          {/* Navigation Links */}
          <div className="hidden md:flex items-center gap-1">
            <NavLink href="/models">Models</NavLink>
            <NavLink href="/chat">Chat</NavLink>
            <NavLink href="/docs">Docs</NavLink>
          </div>

          {/* Auth Section */}
          <div className="flex items-center gap-4">
            <AuthLoading>
              <AuthButtonSkeleton />
            </AuthLoading>
            <SignedIn>
              <UserButton />
            </SignedIn>
            <SignedOut>
              <Link
                href="/auth/sign-in"
                className="inline-flex items-center justify-center rounded-lg bg-accent-main-100 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-main-200 hover:scale-105 active:scale-95"
              >
                Sign In
              </Link>
            </SignedOut>
          </div>
        </div>
      </div>
    </nav>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="px-4 py-2 text-sm font-medium text-text-200 rounded-lg transition-colors hover:text-text-100 hover:bg-bg-200"
    >
      {children}
    </Link>
  );
}
