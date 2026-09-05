import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import {
  ArrowLeftIcon,
  BrainIcon,
  CheckIcon,
  SearchIcon,
  SlidersHorizontalIcon,
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  isSupportedNpm,
  mapModelsDevModel,
  type MappedModel,
  type ModelsDevApi,
  type ModelsDevProvider,
} from "@/utils/models_dev";
import type { AIProviderNpmPackage } from "@/utils/types/ai_provider";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { formatPerMillion, formatTokens, useModelsDevCatalogue } from "./models-dev-catalogue";
import { CustomProviderForm } from "./custom-provider-form";
import { ProviderLogo } from "./provider-logo";
import { OPENAI_CODEX_SLUG } from "@/utils/provider_slugs";

type SupportedProvider = ModelsDevProvider & {
  npm: AIProviderNpmPackage;
  catalogue_provider?: string;
  credential_type?: "api_key" | "oauth";
  oauth_flow?: string;
};

export function ImportProviderDialog({
  open,
  onOpenChange,
  importedSlugs,
  balanceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importedSlugs: string[];
  balanceId: Id<"balances"> | undefined;
}) {
  const { catalogue, error: loadError } = useModelsDevCatalogue(open);
  const [selectedProvider, setSelectedProvider] = useState<SupportedProvider | null>(null);
  const [custom, setCustom] = useState(false);

  function reset() {
    setSelectedProvider(null);
    setCustom(false);
  }

  function done() {
    onOpenChange(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-h-[85svh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {custom ? (
          <CustomProviderForm
            importedSlugs={importedSlugs}
            onBack={() => setCustom(false)}
            onDone={done}
          />
        ) : selectedProvider ? (
          <ConfigureProvider
            provider={selectedProvider}
            alreadyImported={importedSlugs.includes(selectedProvider.id)}
            balanceId={balanceId}
            onBack={() => setSelectedProvider(null)}
            onDone={done}
          />
        ) : (
          <BrowseProviders
            catalogue={catalogue}
            loadError={loadError}
            importedSlugs={importedSlugs}
            onSelect={setSelectedProvider}
            onCustom={() => setCustom(true)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BrowseProviders({
  catalogue,
  loadError,
  importedSlugs,
  onSelect,
  onCustom,
}: {
  catalogue: ModelsDevApi | null;
  loadError: string | null;
  importedSlugs: string[];
  onSelect: (provider: SupportedProvider) => void;
  onCustom: () => void;
}) {
  const [search, setSearch] = useState("");

  const providers = useMemo(() => {
    if (!catalogue) return [];
    const query = search.trim().toLowerCase();
    const openAI = catalogue.openai;
    const subscriptionProvider: SupportedProvider[] = openAI
      ? [
          {
            ...openAI,
            id: OPENAI_CODEX_SLUG,
            name: "ChatGPT Subscription",
            npm: "@opencoredev/loginwithchatgpt-ai",
            env: ["sessionCookie"],
            api: undefined,
            doc: "https://github.com/opencoredev/login-with-chatgpt",
            catalogue_provider: "openai",
            credential_type: "oauth",
            oauth_flow: "chatgpt-device",
          },
        ]
      : [];

    return [...subscriptionProvider, ...Object.values(catalogue)]
      .filter((provider) =>
        query ? `${provider.name} ${provider.id}`.toLowerCase().includes(query) : true,
      )
      .sort((a, b) => {
        if (a.id === OPENAI_CODEX_SLUG) return -1;
        if (b.id === OPENAI_CODEX_SLUG) return 1;
        const supported = Number(isSupportedNpm(b.npm)) - Number(isSupportedNpm(a.npm));
        return supported !== 0 ? supported : a.name.localeCompare(b.name);
      });
  }, [catalogue, search]);

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>Add a provider</DialogTitle>
        <DialogDescription>
          Import a provider from models.dev. Only providers on a supported SDK can be connected.
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-2 px-6 pb-4">
        <InputGroup className="flex-1">
          <InputGroupInput
            placeholder="Search providers…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
        <Button variant="outline" onClick={onCustom}>
          <SlidersHorizontalIcon data-icon="inline-start" />
          Custom
        </Button>
      </div>

      <ScrollArea className="h-[50svh] border-t">
        {loadError ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlertIcon />
              </EmptyMedia>
              <EmptyTitle>Couldn’t reach models.dev</EmptyTitle>
              <EmptyDescription>{loadError}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : !catalogue ? (
          <div className="flex h-[40svh] items-center justify-center text-muted-foreground">
            <Spinner /> <span className="ml-2 text-sm">Loading catalogue…</span>
          </div>
        ) : (
          <div className="flex flex-col p-2">
            {providers.map((provider) => {
              const supported = isSupportedNpm(provider.npm);
              const imported = importedSlugs.includes(provider.id);
              const modelCount = Object.keys(provider.models ?? {}).length;

              return (
                <button
                  key={provider.id}
                  type="button"
                  disabled={!supported}
                  onClick={() => supported && onSelect(provider as SupportedProvider)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors",
                    supported ? "hover:bg-accent" : "cursor-not-allowed opacity-50",
                  )}
                >
                  <ProviderLogo slug={provider.id} className="size-7" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{provider.name}</span>
                      {imported && (
                        <Badge variant="secondary" className="gap-1">
                          <CheckIcon className="size-3" /> Imported
                        </Badge>
                      )}
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {provider.npm ?? "no SDK"} · {modelCount} models
                    </span>
                  </div>
                  {!supported && <Badge variant="outline">Unsupported</Badge>}
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </>
  );
}

function ConfigureProvider({
  provider,
  alreadyImported,
  balanceId,
  onBack,
  onDone,
}: {
  provider: SupportedProvider;
  alreadyImported: boolean;
  balanceId: Id<"balances"> | undefined;
  onBack: () => void;
  onDone: () => void;
}) {
  const importProvider = useMutation(api.providers.importProvider);
  const upsertCredentials = useMutation(api.providers.upsertCredentials);

  const mapped = useMemo<MappedModel[]>(
    () =>
      Object.values(provider.models ?? {}).map((model) => {
        const mapped = mapModelsDevModel(provider.catalogue_provider ?? provider.id, model);
        return provider.credential_type === "oauth"
          ? {
              ...mapped,
              provider: {
                ...mapped.provider,
                pricing: { input: "0", output: "0" },
              },
            }
          : mapped;
      }),
    [provider],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [authorNames, setAuthorNames] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [addKeyNow, setAddKeyNow] = useState(false);
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? mapped.filter((m) => `${m.global.name} ${m.global.slug}`.toLowerCase().includes(query))
      : mapped;
  }, [mapped, search]);

  /** Distinct authors across the *selected* models, for unknown-author renaming. */
  const authors = useMemo(() => {
    const bySlug = new Map<string, string>();
    for (const model of mapped) {
      if (selected.has(model.upstreamId))
        bySlug.set(model.global.author.slug, model.global.author.name);
    }
    return [...bySlug.entries()].map(([slug, name]) => ({ slug, name }));
  }, [mapped, selected]);

  function toggle(upstreamId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(upstreamId)) next.delete(upstreamId);
      else next.add(upstreamId);
      return next;
    });
  }

  async function submit() {
    const chosen = mapped.filter((model) => selected.has(model.upstreamId));
    if (chosen.length === 0) {
      toast.error("Select at least one model to import.");
      return;
    }

    setSubmitting(true);
    try {
      await importProvider({
        provider: {
          slug: provider.id,
          name: provider.name,
          npm: provider.npm,
          env: provider.env ?? [],
          catalogue_provider: provider.catalogue_provider,
          credential_type: provider.credential_type,
          oauth_flow: provider.oauth_flow,
          doc: provider.doc,
          api: provider.api,
          enabled: true,
        },
        models: chosen.map((model) => ({
          global: {
            ...model.global,
            author: {
              slug: model.global.author.slug,
              name: authorNames[model.global.author.slug]?.trim() || model.global.author.name,
            },
          },
          provider: model.provider,
        })),
      });

      if (
        provider.credential_type !== "oauth" &&
        addKeyNow &&
        balanceId &&
        (provider.env?.length ?? 0) > 0
      ) {
        await upsertCredentials({
          balance: balanceId,
          provider: provider.id,
          credentials,
        });
      }

      toast.success(`Imported ${provider.name} with ${chosen.length} models.`);
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to import provider.");
    } finally {
      setSubmitting(false);
    }
  }

  const envVars = provider.env ?? [];
  const credentialsComplete = envVars.every((name) => credentials[name]?.trim());

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ArrowLeftIcon />
          </Button>
          <ProviderLogo slug={provider.id} className="size-8" />
          <div className="flex flex-col">
            <DialogTitle className="flex items-center gap-2">
              {provider.name}
              {alreadyImported && <Badge variant="secondary">Re-import</Badge>}
            </DialogTitle>
            <DialogDescription>
              {provider.npm} · {selected.size}/{mapped.length} models selected
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="flex items-center gap-2 px-6 pb-3">
        <InputGroup className="flex-1">
          <InputGroupInput
            placeholder="Filter models…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setSelected((prev) =>
              prev.size === mapped.length ? new Set() : new Set(mapped.map((m) => m.upstreamId)),
            )
          }
        >
          {selected.size === mapped.length ? "Clear all" : "Select all"}
        </Button>
      </div>

      <ScrollArea className="h-[38svh] border-y">
        <div className="flex flex-col p-2">
          {filtered.map((model) => {
            const checked = selected.has(model.upstreamId);
            return (
              <label
                key={model.upstreamId}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent",
                  checked && "bg-accent/50",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(model.upstreamId)}
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
      </ScrollArea>

      <div className="max-h-[28svh] overflow-y-auto px-6 py-4">
        <FieldGroup>
          {authors.length > 0 && (
            <Field>
              <FieldLabel>Authors</FieldLabel>
              <div className="flex flex-col gap-2">
                {authors.map((author) => (
                  <div key={author.slug} className="flex items-center gap-2">
                    <ProviderLogo slug={author.slug} variant="labs" className="size-5" />
                    <Input
                      aria-label={`Author name for ${author.slug}`}
                      value={authorNames[author.slug] ?? author.name}
                      onChange={(event) =>
                        setAuthorNames((prev) => ({ ...prev, [author.slug]: event.target.value }))
                      }
                    />
                    <code className="shrink-0 text-xs text-muted-foreground">{author.slug}</code>
                  </div>
                ))}
              </div>
            </Field>
          )}

          {provider.credential_type === "oauth" ? (
            <Field>
              <FieldLabel>Subscription authentication</FieldLabel>
              <p className="text-sm text-muted-foreground">
                Import the provider first, then connect your ChatGPT plan from Credentials using
                OpenAI's device-code flow.
              </p>
            </Field>
          ) : envVars.length > 0 ? (
            <>
              <Separator />
              <Field orientation="horizontal">
                <Checkbox
                  id="add-key-now"
                  checked={addKeyNow}
                  onCheckedChange={(value) => setAddKeyNow(value === true)}
                  disabled={!balanceId}
                />
                <FieldLabel htmlFor="add-key-now" className="font-normal">
                  Add my API key now (BYOK)
                  {!balanceId && " — requires a balance"}
                </FieldLabel>
              </Field>
              {addKeyNow &&
                envVars.map((name) => (
                  <Field key={name}>
                    <FieldLabel htmlFor={`env-${name}`}>{name}</FieldLabel>
                    <Input
                      id={`env-${name}`}
                      type="password"
                      autoComplete="off"
                      placeholder={`Enter ${name}`}
                      value={credentials[name] ?? ""}
                      onChange={(event) =>
                        setCredentials((prev) => ({ ...prev, [name]: event.target.value }))
                      }
                    />
                  </Field>
                ))}
            </>
          ) : null}
        </FieldGroup>
      </div>

      <DialogFooter className="border-t p-4">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button onClick={submit} disabled={submitting || (addKeyNow && !credentialsComplete)}>
          {submitting && <Spinner data-icon="inline-start" />}
          Import {selected.size} {selected.size === 1 ? "model" : "models"}
        </Button>
      </DialogFooter>
    </>
  );
}
