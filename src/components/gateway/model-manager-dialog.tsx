import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import {
  ArrowLeftIcon,
  BrainIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { mapModelsDevModel, type MappedModel } from "@/utils/models_dev";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { formatPerMillion, formatTokens, useModelsDevCatalogue } from "./models-dev-catalogue";
import { ProviderLogo } from "./provider-logo";

type ManagerView = "list" | "catalogue" | "custom";

export function ModelManagerDialog({
  provider,
  onOpenChange,
}: {
  provider: Doc<"providers"> | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [view, setView] = useState<ManagerView>("list");

  function close(open: boolean) {
    onOpenChange(open);
    if (!open) setView("list");
  }

  return (
    <Dialog open={provider !== null} onOpenChange={close}>
      <DialogContent className="max-h-[85svh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {provider && view === "catalogue" ? (
          <AddFromCatalogue provider={provider} onBack={() => setView("list")} />
        ) : provider && view === "custom" ? (
          <AddCustomModel provider={provider} onBack={() => setView("list")} />
        ) : provider ? (
          <ManagerList
            provider={provider}
            onAddCatalogue={() => setView("catalogue")}
            onAddCustom={() => setView("custom")}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ManagerList({
  provider,
  onAddCatalogue,
  onAddCustom,
}: {
  provider: Doc<"providers">;
  onAddCatalogue: () => void;
  onAddCustom: () => void;
}) {
  const removeModel = useMutation(api.providers.removeProviderModel);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(model: string) {
    setRemoving(model);
    try {
      await removeModel({ slug: provider.slug, model });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove model.");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <div className="flex items-center gap-3">
          <ProviderLogo slug={provider.slug} className="size-8" />
          <div className="flex flex-col">
            <DialogTitle>{provider.name} models</DialogTitle>
            <DialogDescription>
              {provider.models.length} model{provider.models.length === 1 ? "" : "s"} exposed
              through the gateway.
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="flex items-center gap-2 px-6 pb-3">
        <Button variant="outline" size="sm" className="flex-1" onClick={onAddCatalogue}>
          <SparklesIcon data-icon="inline-start" />
          Add from models.dev
        </Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={onAddCustom}>
          <PlusIcon data-icon="inline-start" />
          Add custom model
        </Button>
      </div>

      <ScrollArea className="h-[55svh] border-t">
        {provider.models.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SparklesIcon />
              </EmptyMedia>
              <EmptyTitle>No models yet</EmptyTitle>
              <EmptyDescription>
                Add models from models.dev or define a custom one.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col p-2">
            {provider.models.map((model) => (
              <div
                key={model.model}
                className="flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-accent"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-mono text-sm">{model.model}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {model.context > 0 && (
                      <Badge variant="outline">{formatTokens(model.context)} ctx</Badge>
                    )}
                    <Badge variant="outline">${formatPerMillion(model.pricing.input)}/M in</Badge>
                    <Badge variant="outline">${formatPerMillion(model.pricing.output)}/M out</Badge>
                    {model.supported_parameters.includes("tools") && (
                      <WrenchIcon className="size-3.5 self-center text-muted-foreground" />
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={removing === model.model}
                  onClick={() => remove(model.model)}
                  aria-label={`Remove ${model.model}`}
                >
                  {removing === model.model ? <Spinner /> : <Trash2Icon />}
                </Button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <DialogFooter className="border-t p-4" />
    </>
  );
}

function AddFromCatalogue({
  provider,
  onBack,
}: {
  provider: Doc<"providers">;
  onBack: () => void;
}) {
  const { catalogue, error } = useModelsDevCatalogue(true);
  const addModels = useMutation(api.providers.addProviderModels);

  const existing = useMemo(
    () => new Set(provider.models.map((model) => model.model)),
    [provider.models],
  );

  const available = useMemo<MappedModel[]>(() => {
    const catalogueProvider = provider.catalogue_provider ?? provider.slug;
    const entry = catalogue?.[catalogueProvider];
    if (!entry) return [];
    return Object.values(entry.models ?? {})
      .map((model) => {
        const mapped = mapModelsDevModel(catalogueProvider, model);
        return provider.credential_type === "oauth"
          ? { ...mapped, provider: { ...mapped.provider, pricing: { input: "0", output: "0" } } }
          : mapped;
      })
      .filter((model) => !existing.has(model.provider.model));
  }, [catalogue, provider.catalogue_provider, provider.credential_type, provider.slug, existing]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? available.filter((model) =>
          `${model.global.name} ${model.global.slug}`.toLowerCase().includes(query),
        )
      : available;
  }, [available, search]);

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function submit() {
    const chosen = available.filter((model) => selected.has(model.provider.model));
    if (chosen.length === 0) return;
    setSubmitting(true);
    try {
      await addModels({
        slug: provider.slug,
        models: chosen.map((model) => ({ global: model.global, provider: model.provider })),
      });
      toast.success(`Added ${chosen.length} model${chosen.length === 1 ? "" : "s"}.`);
      onBack();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add models.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ArrowLeftIcon />
          </Button>
          <ProviderLogo slug={provider.slug} className="size-8" />
          <div className="flex flex-col">
            <DialogTitle>Add models</DialogTitle>
            <DialogDescription>{selected.size} selected from models.dev</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="px-6 pb-3">
        <InputGroup>
          <InputGroupInput
            placeholder="Filter models…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
      </div>

      <ScrollArea className="h-[48svh] border-y">
        {error ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlertIcon />
              </EmptyMedia>
              <EmptyTitle>Couldn’t reach models.dev</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : !catalogue ? (
          <div className="flex h-[40svh] items-center justify-center text-muted-foreground">
            <Spinner /> <span className="ml-2 text-sm">Loading catalogue…</span>
          </div>
        ) : available.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SparklesIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing to add</EmptyTitle>
              <EmptyDescription>
                {catalogue[provider.catalogue_provider ?? provider.slug]
                  ? "Every catalogue model for this provider is already added."
                  : "This provider isn’t on models.dev. Add a custom model instead."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col p-2">
            {filtered.map((model) => {
              const checked = selected.has(model.provider.model);
              return (
                <label
                  key={model.provider.model}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent",
                    checked && "bg-accent/50",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(model.provider.model)}
                    className="mt-0.5"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{model.global.name}</span>
                      {model.global.reasoning && (
                        <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      {model.provider.supported_parameters.includes("tools") && (
                        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </div>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {model.global.slug}
                    </span>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {model.provider.context > 0 && (
                        <Badge variant="outline">{formatTokens(model.provider.context)} ctx</Badge>
                      )}
                      <Badge variant="outline">
                        ${formatPerMillion(model.provider.pricing.input)}/M in
                      </Badge>
                      <Badge variant="outline">
                        ${formatPerMillion(model.provider.pricing.output)}/M out
                      </Badge>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </ScrollArea>

      <DialogFooter className="p-4">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button onClick={submit} disabled={submitting || selected.size === 0}>
          {submitting && <Spinner data-icon="inline-start" />}
          Add {selected.size} {selected.size === 1 ? "model" : "models"}
        </Button>
      </DialogFooter>
    </>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Dollars-per-million-tokens (as typed) to the per-token string we store. */
function perTokenString(dollarsPerMillion: string): string {
  const value = parseFloat(dollarsPerMillion);
  if (!Number.isFinite(value) || value === 0) return "0";
  return (value / 1_000_000).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

function AddCustomModel({ provider, onBack }: { provider: Doc<"providers">; onBack: () => void }) {
  const addModels = useMutation(api.providers.addProviderModels);

  const [name, setName] = useState("");
  const [upstreamId, setUpstreamId] = useState("");
  const [context, setContext] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [tools, setTools] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const slug = `${provider.slug}/${slugify(name) || "model"}`;
  const valid = name.trim().length > 0 && upstreamId.trim().length > 0;

  async function submit() {
    if (!valid) return;
    setSubmitting(true);
    try {
      const supported_parameters: MappedModel["provider"]["supported_parameters"] = [
        "max_tokens",
        "stop",
        "seed",
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
      ];
      if (tools) supported_parameters.push("tools", "tool_choice", "parallel_tool_calls");

      await addModels({
        slug: provider.slug,
        models: [
          {
            global: {
              name: name.trim(),
              slug,
              launch_date: Date.now(),
              type: "chat",
              description: "",
              reasoning,
              features: {},
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
                tokenizer: "GPT",
              },
              author: { slug: provider.slug, name: provider.name },
            },
            provider: {
              model: slug,
              upstream_model_id: upstreamId.trim(),
              context: Number(context) || 0,
              max_output: Number(maxOutput) || 0,
              pricing: {
                input: perTokenString(inputPrice || "0"),
                output: perTokenString(outputPrice || "0"),
              },
              supported_parameters,
              moderated: false,
            },
          },
        ],
      });
      toast.success(`Added ${name.trim()}.`);
      onBack();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add model.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ArrowLeftIcon />
          </Button>
          <div className="flex flex-col">
            <DialogTitle>Custom model</DialogTitle>
            <DialogDescription className="font-mono text-xs">{slug}</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="max-h-[58svh] overflow-y-auto border-y px-6 py-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="cm-name">Display name</FieldLabel>
            <Input
              id="cm-name"
              placeholder="My Model"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="cm-upstream">Upstream model id</FieldLabel>
            <Input
              id="cm-upstream"
              placeholder="gpt-4o-mini"
              value={upstreamId}
              onChange={(event) => setUpstreamId(event.target.value)}
            />
            <FieldDescription>The id sent to the provider’s API.</FieldDescription>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="cm-context">Context tokens</FieldLabel>
              <Input
                id="cm-context"
                inputMode="numeric"
                placeholder="128000"
                value={context}
                onChange={(event) => setContext(event.target.value.replace(/[^0-9]/g, ""))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cm-output">Max output</FieldLabel>
              <Input
                id="cm-output"
                inputMode="numeric"
                placeholder="16384"
                value={maxOutput}
                onChange={(event) => setMaxOutput(event.target.value.replace(/[^0-9]/g, ""))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="cm-in">Input $/M</FieldLabel>
              <Input
                id="cm-in"
                inputMode="decimal"
                placeholder="0.15"
                value={inputPrice}
                onChange={(event) => setInputPrice(event.target.value.replace(/[^0-9.]/g, ""))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cm-out">Output $/M</FieldLabel>
              <Input
                id="cm-out"
                inputMode="decimal"
                placeholder="0.60"
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value.replace(/[^0-9.]/g, ""))}
              />
            </Field>
          </div>

          <Field orientation="horizontal">
            <FieldLabel htmlFor="cm-reasoning" className="font-normal">
              Reasoning model
            </FieldLabel>
            <Switch id="cm-reasoning" checked={reasoning} onCheckedChange={setReasoning} />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="cm-tools" className="font-normal">
              Supports tool calling
            </FieldLabel>
            <Switch id="cm-tools" checked={tools} onCheckedChange={setTools} />
          </Field>
        </FieldGroup>
      </div>

      <DialogFooter className="p-4">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button onClick={submit} disabled={submitting || !valid}>
          {submitting && <Spinner data-icon="inline-start" />}
          Add model
        </Button>
      </DialogFooter>
    </>
  );
}
