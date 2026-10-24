import { cn } from "@/lib/utils";

/** Square initial tile that identifies a Project in lists, Tabs, and the Session context. */
export function ProjectTile({ initial, className }: { initial: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-brand text-[10px] leading-none font-semibold text-white",
        className,
      )}
    >
      {initial}
    </span>
  );
}
