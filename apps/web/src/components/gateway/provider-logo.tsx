import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Providers without a models.dev logo whose own artwork is published elsewhere: OpenCode's
 * `claude-agent` provider (a Claude subscription through the Claude Agent SDK) uses the ACP
 * registry's Claude Agent mark.
 */
const providerLogoUrls: Record<string, string> = {
  "claude-agent": "https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg",
};

/**
 * Renders a models.dev provider or author ("labs") logo, falling back to a
 * monogram tile when the SVG is missing (many long-tail slugs have no logo).
 */
export function ProviderLogo({
  slug,
  variant = "provider",
  className,
}: {
  slug: string;
  variant?: "provider" | "labs";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const logoSlug =
    variant === "provider" && ["openai-codex", "chatgpt-subscription"].includes(slug)
      ? "openai"
      : slug;
  const src =
    (variant === "provider" ? providerLogoUrls[slug] : undefined) ??
    `https://models.dev/logos/${variant === "labs" ? "labs/" : ""}${logoSlug}.svg`;

  // Reset the error state when the slug changes so a new logo gets a fresh try.
  useEffect(() => setFailed(false), [slug]);

  if (failed) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-semibold uppercase text-muted-foreground ring-1 ring-border/70",
          className,
        )}
        aria-hidden
      >
        {slug.slice(0, 2)}
      </span>
    );
  }

  return (
    <img
      alt={`${slug} logo`}
      src={src}
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-full bg-white p-0.5 ring-1 ring-border/70", className)}
    />
  );
}
