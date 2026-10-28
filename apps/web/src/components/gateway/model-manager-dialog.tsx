import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
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
import {
  fetchOpenRouterServiceTiers,
  mapModelsDevModel,
  type MappedModel,
} from "backend/src/models_dev";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import type { WorkspaceProviderView } from "backend/src/workspaces/provider";
import { formatPerMillion, formatTokens, useModelsDevCatalogue } from "./models-dev-catalogue";
import { ProviderLogo } from "./provider-logo";

type ManagerView = "list" | "catalogue" | "refresh" | "custom" | "tiers";

export function ModelManagerDialog({
  provider,
  onOpenChange,
}: {
  provider: WorkspaceProviderView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspaceId } = useWorkspace();
  const [view, setView] = useState<ManagerView>("list");
  const [tierModel, setTierModel] = useState<string>();

  function close(open: boolean) {
    onOpenChange(open);
    if (!open) setView("list");
  }

  return (
    <Dialog open={provider !== null} onOpenChange={close}>
      <DialogContent className="max-h-[85svh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {provider && (view === "catalogue" || view === "refresh") ? (
          <AddFromCatalogue
            provider={provider}
            workspaceId={workspaceId}
            refresh={view === "refresh"}
            onBack={() => setView("list")}
          />
        ) : provider && view === "custom" ? (
          <AddCustomModel
            provider={provider}
            workspaceId={workspaceId}
            onBack={() => setView("list")}
          />
        ) : provider && view === "tiers" && tierModel ? (
          <EditModelTiers
            provider={provider}
            modelId={tierModel}
            workspaceId={workspaceId}
            onBack={() => setView("list")}
          />
        ) : provider ? (
          <ManagerList
            provider={provider}
            workspaceId={workspaceId}
            onAddCatalogue={() => setView("catalogue")}
            onRefresh={() => setView("refresh")}
            onAddCustom={() => setView("custom")}
            onEditTiers={(model) => {
              setTierModel(model);
              setView("tiers");
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ManagerList({
  provider,
  workspaceId,
  onAddCatalogue,
  onRefresh,
  onAddCustom,
  onEditTiers,
}: {
  provider: WorkspaceProviderView;
  workspaceId: Id<"workspaces"> | undefined;
  onAddCatalogue: () => void;
  onRefresh: () => void;
  onAddCustom: () => void;
  onEditTiers: (model: string) => void;
}) {
  const removeModel = useMutation(api.providers.removeProviderModel);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(model: string) {
    setRemoving(model);
    try {
      if (!workspaceId) return;
      await removeModel({ workspace: workspaceId, slug: provider.slug, model });
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
      {provider.models.length > 0 && (
        <div className="px-6 pb-3">
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            Refresh existing models from models.dev
          </Button>
        </div>
      )}

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
                    <Badge variant="outline">{formatPerMillion(model.pricing.input)} in</Badge>
                    <Badge variant="outline">{formatPerMillion(model.pricing.output)} out</Badge>
                    {model.supported_parameters.includes("tools") && (
                      <WrenchIcon className="size-3.5 self-center text-muted-foreground" />
                    )}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => onEditTiers(model.model)}>
                  Tiers
                </Button>
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
  workspaceId,
  onBack,
  refresh,
}: {
  provider: WorkspaceProviderView;
  workspaceId: Id<"workspaces"> | undefined;
  refresh: boolean;
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
    const mapped = Object.values(entry.models ?? {}).map((model) =>
      mapModelsDevModel(catalogueProvider, model),
    );
    if (!refresh) return mapped.filter((model) => !existing.has(model.provider.model));
    return provider.models.flatMap((current) => {
      const match = mapped.find((model) =>
        current.upstream_model_id
          ? current.upstream_model_id === model.upstreamId
          : current.model === model.provider.model || current.model === model.upstreamId,
      );
      return match ? [{ ...match, provider: { ...match.provider, model: current.model } }] : [];
    });
  }, [catalogue, provider.catalogue_provider, provider.slug, provider.models, existing, refresh]);

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
    if (chosen.length === 0 || !workspaceId) return;
    setSubmitting(true);
    try {
      const tiered =
        provider.npm === "@openrouter/ai-sdk-provider"
          ? await Promise.all(
              chosen.map(async (model) => {
                const fetched = await fetchOpenRouterServiceTiers(model.upstreamId);
                return {
                  ...model,
                  provider: {
                    ...model.provider,
                    service_tiers: [
                      ...(model.provider.service_tiers ?? []).map((tier) => {
                        const endpoint = fetched?.find((item) => item.id === tier.id);
                        return tier.pricing || !endpoint?.pricing
                          ? tier
                          : { ...tier, pricing: endpoint.pricing };
                      }),
                      ...(fetched ?? []).filter(
                        (tier) =>
                          !model.provider.service_tiers?.some((item) => item.id === tier.id),
                      ),
                    ],
                  },
                };
              }),
            )
          : chosen;
      await addModels({
        workspace: workspaceId,
        slug: provider.slug,
        models: tiered.map((model) => {
          const current = refresh
            ? provider.models.find((entry) => entry.model === model.provider.model)
            : undefined;
          return {
            global: current ? { ...model.global, slug: current.model } : model.global,
            provider: current
              ? {
                  ...current,
                  pricing: model.provider.pricing,
                  service_tiers: model.provider.service_tiers,
                  inference_modes: model.provider.inference_modes,
                }
              : model.provider,
          };
        }),
      });
      toast.success(
        `${refresh ? "Refreshed" : "Added"} ${chosen.length} model${chosen.length === 1 ? "" : "s"}.`,
      );
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
            <DialogTitle>{refresh ? "Refresh model pricing and modes" : "Add models"}</DialogTitle>
            <DialogDescription>
              {refresh
                ? `${selected.size} selected. Refresh replaces their pricing, tiers and modes; other configuration is preserved.`
                : `${selected.size} selected from models.dev`}
            </DialogDescription>
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
              <EmptyTitle>{refresh ? "No matching models" : "Nothing to add"}</EmptyTitle>
              <EmptyDescription>
                {refresh
                  ? "No configured upstream models match this catalogue."
                  : catalogue[provider.catalogue_provider ?? provider.slug]
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
                      {refresh ? model.provider.model : model.global.slug}
                    </span>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {model.provider.context > 0 && (
                        <Badge variant="outline">{formatTokens(model.provider.context)} ctx</Badge>
                      )}
                      <Badge variant="outline">
                        {formatPerMillion(model.provider.pricing.input)} in
                      </Badge>
                      <Badge variant="outline">
                        {formatPerMillion(model.provider.pricing.output)} out
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
          {refresh ? "Refresh" : "Add"} {selected.size} {selected.size === 1 ? "model" : "models"}
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

/** Shift a decimal price without rounding while converting per-token and per-million rates. */
function shiftPrice(value: string, places: number): string {
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(
    value.startsWith(".") ? `0${value}` : value,
  );
  if (!match) return "";
  const digits = match[1] + (match[2] ?? "");
  const point = match[1].length + Number(match[3] ?? 0) + places;
  let result: string;
  if (point <= 0) result = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) result = digits + "0".repeat(point - digits.length);
  else result = `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole, fraction] = result.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction?.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function perTokenString(dollarsPerMillion: string): string {
  return shiftPrice(dollarsPerMillion, -6);
}

type TierRate = {
  id: string;
  enabled: boolean;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  cacheWrite1h: string;
  source?: string;
  thresholds?: WorkspaceProviderView["models"][number]["pricing"]["tiers"];
};

export function initialTierRates(
  tiers: WorkspaceProviderView["models"][number]["service_tiers"] = [],
  base?: WorkspaceProviderView["models"][number]["pricing"],
): TierRate[] {
  const ids = [
    ...new Set(["default", "flex", "priority", "ultrafast", ...tiers.map((tier) => tier.id)]),
  ];
  const perMillion = (rate: string | undefined) =>
    rate === undefined || rate === "" ? "" : shiftPrice(rate, 6);
  return ids.map((id) => {
    const tier = tiers.find((entry) => entry.id === id);
    const pricing = tier?.pricing ?? (id === "default" ? base : undefined);
    return {
      id,
      enabled: id === "default" || tier !== undefined,
      source: tier?.source,
      thresholds: pricing?.tiers,
      input: perMillion(pricing?.input),
      output: perMillion(pricing?.output),
      cacheRead: perMillion(pricing?.cache_read),
      cacheWrite: perMillion(pricing?.cache_write),
      cacheWrite1h: perMillion(pricing?.cache_write_1h),
    };
  });
}

function validTierRates(tiers: TierRate[]) {
  return tiers.every((tier) => {
    if (!tier.enabled) return true;
    const rates = [tier.input, tier.output, tier.cacheRead, tier.cacheWrite, tier.cacheWrite1h];
    if (rates.every((rate) => !rate)) return true;
    return (
      Boolean(tier.input && tier.output) &&
      rates.every((rate) => !rate || (Number.isFinite(Number(rate)) && Number(rate) >= 0))
    );
  });
}

export function tierPricing(tiers: TierRate[]) {
  return tiers
    .filter((tier) => tier.enabled)
    .map((tier) => ({
      id: tier.id,
      ...(tier.source ? { source: tier.source } : {}),
      ...(tier.input && tier.output
        ? {
            pricing: {
              input: perTokenString(tier.input),
              output: perTokenString(tier.output),
              ...(tier.cacheRead ? { cache_read: perTokenString(tier.cacheRead) } : {}),
              ...(tier.cacheWrite ? { cache_write: perTokenString(tier.cacheWrite) } : {}),
              ...(tier.cacheWrite1h ? { cache_write_1h: perTokenString(tier.cacheWrite1h) } : {}),
              ...(tier.thresholds ? { tiers: tier.thresholds } : {}),
            },
          }
        : {}),
    }));
}

function TierRateFields({
  tierRates,
  setTierRates,
}: {
  tierRates: TierRate[];
  setTierRates: Dispatch<SetStateAction<TierRate[]>>;
}) {
  const labels = {
    input: "Input",
    output: "Output",
    cacheRead: "Cache read",
    cacheWrite: "Cache write (5m)",
    cacheWrite1h: "Cache write (1h)",
  };
  return (
    <Field>
      <FieldLabel>Service tiers</FieldLabel>
      <FieldDescription>
        Enable supported tiers. Leave all rates blank when unknown; otherwise input and output rates
        are required. Rates are dollars per million tokens.
      </FieldDescription>
      {tierRates.map((tier, index) => (
        <div key={tier.id} className="flex flex-col gap-2 border-t py-2">
          <Field orientation="horizontal">
            <FieldLabel htmlFor={`cm-tier-${tier.id}`} className="font-normal">
              {tier.id}
            </FieldLabel>
            <Switch
              id={`cm-tier-${tier.id}`}
              checked={tier.enabled}
              disabled={tier.id === "default"}
              onCheckedChange={(enabled) =>
                setTierRates((current) =>
                  current.map((item, i) => (i === index ? { ...item, enabled } : item)),
                )
              }
            />
          </Field>
          {tier.enabled && (
            <div className="grid grid-cols-2 gap-2">
              {(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const).map(
                (field) => (
                  <Field key={field}>
                    <FieldLabel htmlFor={`cm-tier-${tier.id}-${field}`}>
                      {labels[field]} $/M
                    </FieldLabel>
                    <Input
                      id={`cm-tier-${tier.id}-${field}`}
                      inputMode="decimal"
                      value={tier[field]}
                      onChange={(event) => {
                        const value = event.target.value.replace(/[^0-9.]/g, "");
                        setTierRates((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, [field]: value } : item,
                          ),
                        );
                      }}
                    />
                  </Field>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </Field>
  );
}

function EditModelTiers({
  provider,
  modelId,
  workspaceId,
  onBack,
}: {
  provider: WorkspaceProviderView;
  modelId: string;
  workspaceId: Id<"workspaces"> | undefined;
  onBack: () => void;
}) {
  const update = useMutation(api.providers.setProviderModelServiceTiers);
  const model = provider.models.find((entry) => entry.model === modelId);
  const [tierRates, setTierRates] = useState(() =>
    initialTierRates(model?.service_tiers, model?.pricing),
  );
  const [submitting, setSubmitting] = useState(false);

  async function save() {
    if (!workspaceId || !model || !validTierRates(tierRates)) return;
    setSubmitting(true);
    try {
      await update({
        workspace: workspaceId,
        slug: provider.slug,
        model: modelId,
        service_tiers: tierPricing(tierRates),
      });
      toast.success("Service tiers updated.");
      onBack();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update service tiers.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>Service tiers</DialogTitle>
        <DialogDescription className="font-mono text-xs">{modelId}</DialogDescription>
      </DialogHeader>
      <div className="max-h-[58svh] overflow-y-auto border-y px-6 py-4">
        <TierRateFields tierRates={tierRates} setTierRates={setTierRates} />
      </div>
      <DialogFooter className="p-4">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button onClick={save} disabled={submitting || !model || !validTierRates(tierRates)}>
          {submitting && <Spinner data-icon="inline-start" />} Save
        </Button>
      </DialogFooter>
    </>
  );
}

function AddCustomModel({
  provider,
  workspaceId,
  onBack,
}: {
  provider: WorkspaceProviderView;
  workspaceId: Id<"workspaces"> | undefined;
  onBack: () => void;
}) {
  const addModels = useMutation(api.providers.addProviderModels);

  const [name, setName] = useState("");
  const [upstreamId, setUpstreamId] = useState("");
  const [context, setContext] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [cacheReadPrice, setCacheReadPrice] = useState("");
  const [cacheWritePrice, setCacheWritePrice] = useState("");
  const [cacheWrite1hPrice, setCacheWrite1hPrice] = useState("");
  const [tierRates, setTierRates] = useState(() => initialTierRates());
  const [reasoning, setReasoning] = useState(false);
  const [tools, setTools] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const slug = `${provider.slug}/${slugify(name) || "model"}`;
  const valid =
    name.trim().length > 0 &&
    upstreamId.trim().length > 0 &&
    [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice, cacheWrite1hPrice].every(
      (rate) => !rate || (Number.isFinite(Number(rate)) && Number(rate) >= 0),
    ) &&
    validTierRates(tierRates);

  async function submit() {
    if (!valid || !workspaceId) return;
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
        workspace: workspaceId,
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
                input: inputPrice ? perTokenString(inputPrice) : "",
                output: outputPrice ? perTokenString(outputPrice) : "",
                ...(cacheReadPrice ? { cache_read: perTokenString(cacheReadPrice) } : {}),
                ...(cacheWritePrice ? { cache_write: perTokenString(cacheWritePrice) } : {}),
                ...(cacheWrite1hPrice ? { cache_write_1h: perTokenString(cacheWrite1hPrice) } : {}),
              },
              service_tiers: tierPricing(tierRates),
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

          <div className="grid grid-cols-2 gap-4">
            {(
              [
                ["cache-read", "Cache read", cacheReadPrice, setCacheReadPrice],
                ["cache-write", "Cache write (5m)", cacheWritePrice, setCacheWritePrice],
                ["cache-write-1h", "Cache write (1h)", cacheWrite1hPrice, setCacheWrite1hPrice],
              ] as const
            ).map(([id, label, value, setValue]) => (
              <Field key={id}>
                <FieldLabel htmlFor={`cm-${id}`}>{label} $/M</FieldLabel>
                <Input
                  id={`cm-${id}`}
                  inputMode="decimal"
                  value={value}
                  onChange={(event) => setValue(event.target.value.replace(/[^0-9.]/g, ""))}
                />
              </Field>
            ))}
          </div>

          <TierRateFields tierRates={tierRates} setTierRates={setTierRates} />

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
