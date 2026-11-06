import { cn } from "@/lib/utils";

/**
 * An ACP agent's artwork. Registry icons are monochrome SVGs drawn in `currentColor`, which an
 * `<img>` resolves to black, so they are inverted on the dark theme to read as white. They load
 * from the registry CDN without CORS headers, which rules out CSS masks. Agents without a URL icon
 * get a letter tile.
 */
export function AcpAgentIcon({
  icon,
  name,
  className,
}: {
  icon?: string;
  name: string;
  className?: string;
}) {
  if (icon && /^(?:https?:\/\/|data:image\/)/i.test(icon)) {
    return (
      <img src={icon} alt="" className={cn("shrink-0 object-contain dark:invert", className)} />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded bg-muted text-[10px] font-medium uppercase",
        className,
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}
