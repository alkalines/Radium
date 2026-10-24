import type { ReactNode } from "react";

import { ProviderLogo } from "@/components/gateway/provider-logo";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
  CommandItem,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { ModelOption, ModelProviderOption } from "./model-options";

/**
 * Searchable model list shared by the Composer Model control, fork targets, and workspace
 * defaults. Rows show the lab logo, `Lab: Model`, and the logos of every provider that serves the
 * model; search matches the name, lab, and providers. Put it inside a `Popover` (or any surface);
 * the caller owns open state and what selection means.
 */
export function ModelList<T extends ModelOption>({
  models,
  selectedSlug,
  onSelect,
  heading = "Models",
  placeholder = "Search models…",
  emptyText = "No models found.",
  autoFocus = true,
  className,
  listClassName,
  footer,
}: {
  models: T[];
  selectedSlug?: string;
  onSelect: (model: T) => void;
  heading?: string;
  placeholder?: string;
  emptyText?: string;
  autoFocus?: boolean;
  className?: string;
  listClassName?: string;
  /** Rendered under the list inside the same surface, for example provider and effort controls. */
  footer?: ReactNode;
}) {
  return (
    <Command className={cn("rounded-none bg-transparent", className)}>
      <CommandInput autoFocus={autoFocus} placeholder={placeholder} />
      <CommandList className={listClassName}>
        <CommandEmpty>{emptyText}</CommandEmpty>
        <CommandGroup heading={heading}>
          {models.map((model) => (
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
              {model.author ? (
                <ProviderLogo variant="labs" slug={model.author.slug} className="size-5" />
              ) : null}
              <span className="min-w-0 flex-1 truncate">
                {model.author ? (
                  <span className="text-muted-foreground">{model.author.name}: </span>
                ) : null}
                {model.name}
              </span>
              {model.providers?.length ? <ProviderLogos providers={model.providers} /> : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      {footer}
    </Command>
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
