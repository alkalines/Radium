import { useState, type ReactNode } from "react";
import { BoxIcon, PinIcon } from "lucide-react";

import { ProviderLogo } from "@/components/gateway/provider-logo";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { modelDisplayName, type ModelOption, type ModelProviderOption } from "./model-options";

/**
 * Searchable model list shared by the Composer Model control, fork targets, and workspace
 * defaults. Rows show the lab logo, `Lab: Model`, and the logos of every provider that serves the
 * model; search matches the name, lab, and providers. Put it inside a `Popover` (or any surface);
 * the caller owns open state and what selection means.
 *
 * User model preferences (`useModelPreferences`) are opt-in: `pinnedSlugs` lists those models
 * first under `Pinned` (a search ranks all rows together instead), `hiddenSlugs` drops models
 * unless one is `selectedSlug` (a hidden current choice must stay visible), and `onTogglePin`
 * adds a per-row pin button that never selects the row. Workspace-default pickers omit them so
 * owners can configure any routable model.
 */
export function ModelList<T extends ModelOption>({
  models,
  selectedSlug,
  onSelect,
  pinnedSlugs,
  hiddenSlugs,
  onTogglePin,
  heading = "Models",
  placeholder = "Search models…",
  emptyText = "No models found.",
  autoFocus = true,
  className,
  listClassName,
  extraItems,
  footer,
  noModelsMessage,
}: {
  models: T[];
  selectedSlug?: string;
  onSelect: (model: T) => void;
  pinnedSlugs?: readonly string[];
  hiddenSlugs?: readonly string[];
  onTogglePin?: (model: T, pinned: boolean) => void;
  heading?: string;
  placeholder?: string;
  emptyText?: string;
  autoFocus?: boolean;
  className?: string;
  listClassName?: string;
  /** Extra `CommandItem`s after the models, such as `Manage models`; they search like models. */
  extraItems?: ReactNode;
  /** Rendered under the list inside the same surface, for example provider and effort controls. */
  noModelsMessage?: string;
  footer?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const pinned = new Set(pinnedSlugs);
  const hidden = new Set(hiddenSlugs);
  const visibleModels = models.filter(
    (model) => !hidden.has(model.slug) || model.slug === selectedSlug,
  );

  // cmdk keeps the Pinned group above the rest even when a later row matches better, so a search
  // ranks every row in one group and Enter picks the best match, not merely a pinned one.
  const isSearching = search.trim() !== "";
  const pinnedModels = isSearching ? [] : visibleModels.filter((model) => pinned.has(model.slug));
  const otherModels = isSearching
    ? visibleModels
    : visibleModels.filter((model) => !pinned.has(model.slug));

  function renderRow(model: T) {
    const isPinned = pinned.has(model.slug);

    return (
      <CommandItem
        key={model.slug}
        value={model.slug}
        keywords={[
          model.name,
          model.author?.name ?? "",
          model.author?.slug ?? "",
          ...(model.providers ?? []).flatMap((provider) => [provider.name, provider.id]),
        ]}
        data-checked={model.slug === selectedSlug}
        onSelect={() => onSelect(model)}
      >
        <ModelAuthorLogo author={model.author} />
        <span className="min-w-0 flex-1 truncate">
          {model.author ? (
            <span className="text-muted-foreground">{model.author.name}: </span>
          ) : null}
          {model.name}
        </span>
        {model.providers?.length ? <ProviderLogos providers={model.providers} /> : null}
        {onTogglePin ? (
          <PinButton
            label={modelDisplayName(model)}
            isPinned={isPinned}
            onToggle={() => onTogglePin(model, !isPinned)}
          />
        ) : null}
      </CommandItem>
    );
  }

  return (
    <Command className={cn("rounded-none bg-transparent", className)}>
      {noModelsMessage && models.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">{noModelsMessage}</p>
      ) : (
        <>
          <CommandInput
            autoFocus={autoFocus}
            placeholder={placeholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className={listClassName}>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {pinnedModels.length > 0 ? (
              <CommandGroup heading="Pinned">{pinnedModels.map(renderRow)}</CommandGroup>
            ) : null}
            {otherModels.length > 0 ? (
              <CommandGroup heading={heading}>{otherModels.map(renderRow)}</CommandGroup>
            ) : null}
            {extraItems ? (
              <>
                <CommandSeparator />
                <CommandGroup>{extraItems}</CommandGroup>
              </>
            ) : null}
          </CommandList>
        </>
      )}
      {footer}
    </Command>
  );
}

/**
 * Pin toggle inside a model row. Visible while the row is hovered or highlighted, while it has
 * keyboard focus, and always on pinned rows (touch has no hover, so it always shows there).
 */
function PinButton({
  label,
  isPinned,
  onToggle,
}: {
  label: string;
  isPinned: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`${isPinned ? "Unpin" : "Pin"} ${label}`}
      title={isPinned ? "Unpin" : "Pin"}
      className={cn(
        "-my-1 text-muted-foreground opacity-0 group-hover/command-item:opacity-100 group-data-selected/command-item:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        isPinned && "opacity-100",
      )}
      // The row selects on click and the list on Enter (cmdk listens on the root), so the toggle
      // must keep both events to itself.
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      {/* Filled when pinned, outline otherwise: the glyph shows the state, the label the action. */}
      <PinIcon className={cn("size-3.5", isPinned && "fill-current")} />
    </Button>
  );
}

/** The lab's logo, or a neutral model tile when the lab is unknown, so rows stay aligned. */
export function ModelAuthorLogo({ author }: { author: ModelOption["author"] }) {
  if (author) return <ProviderLogo variant="labs" slug={author.slug} className="size-5" />;
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border/70"
    >
      <BoxIcon className="size-3" />
    </span>
  );
}

/** Overlapping logos of every upstream that can serve a model; names are in the `title`. */
export function ProviderLogos({ providers }: { providers: ModelProviderOption[] }) {
  const logos = [...new Set(providers.map((provider) => provider.logo))];

  return (
    <span
      className="flex shrink-0 -space-x-1"
      title={providers.map((provider) => provider.name).join(", ")}
      aria-label={`Served by ${providers.map((provider) => provider.name).join(", ")}`}
    >
      {logos.map((logo) => (
        <ProviderLogo key={logo} slug={logo} className="size-4" />
      ))}
    </span>
  );
}
