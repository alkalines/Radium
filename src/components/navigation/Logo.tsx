"use client";

import Link from "next/link";

interface LogoProps {
  variant?: "full" | "compact";
  href?: string;
  className?: string;
}

function LogoIcon({ className }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center rounded-lg bg-accent-main-100 ${className ?? "h-8 w-8"}`}>
      <span className="text-lg font-bold text-white">R</span>
    </div>
  );
}

function LogoText() {
  return (
    <span className="text-xl font-semibold text-text-100 group-hover:text-accent-main-100 transition-colors">
      Radium
    </span>
  );
}

export function Logo({ variant = "full", href = "/", className }: LogoProps) {
  const content = (
    <div className={`flex items-center gap-2 group ${className ?? ""}`}>
      <LogoIcon />
      {variant === "full" && <LogoText />}
    </div>
  );

  if (href) {
    return <Link href={href}>{content}</Link>;
  }

  return content;
}

export { LogoIcon, LogoText };
