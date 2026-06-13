import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { ArrowLeftIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { SUPPORTED_NPM } from "@/utils/models_dev";
import type { AIProviderNpmPackage } from "@/utils/types/ai_provider";
import { api } from "../../../convex/_generated/api";

/** Sensible default credential env var for each SDK package. */
const DEFAULT_ENV: Record<AIProviderNpmPackage, string> = {
  "@ai-sdk/openai": "OPENAI_API_KEY",
  "@ai-sdk/anthropic": "ANTHROPIC_API_KEY",
  "@openrouter/ai-sdk-provider": "OPENROUTER_API_KEY",
  "@ai-sdk/openai-compatible": "API_KEY",
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Create a provider that isn't in the models.dev catalogue (self-hosted,
 * OpenAI-compatible gateways, etc.). Persists an empty provider shell — models
 * are added afterwards through the per-provider model manager.
 */
export function CustomProviderForm({
  importedSlugs,
  onBack,
  onDone,
}: {
  importedSlugs: string[];
  onBack: () => void;
  onDone: () => void;
}) {
  const importProvider = useMutation(api.providers.importProvider);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [npm, setNpm] = useState<AIProviderNpmPackage>("@ai-sdk/openai-compatible");
  const [apiBase, setApiBase] = useState("");
  const [env, setEnv] = useState(DEFAULT_ENV["@ai-sdk/openai-compatible"]);
  const [submitting, setSubmitting] = useState(false);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const needsApiBase = npm === "@ai-sdk/openai-compatible";
  const duplicate = importedSlugs.includes(effectiveSlug);

  const envVars = useMemo(
    () =>
      env
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    [env],
  );

  const valid =
    name.trim().length > 0 &&
    effectiveSlug.length > 0 &&
    !duplicate &&
    (!needsApiBase || apiBase.trim().length > 0);

  function changeNpm(next: AIProviderNpmPackage) {
    setNpm(next);
    // Only overwrite env if the user hasn't customised it away from a default.
    if ((Object.values(DEFAULT_ENV) as string[]).includes(env.trim())) {
      setEnv(DEFAULT_ENV[next]);
    }
  }

  async function submit() {
    if (!valid) return;
    setSubmitting(true);
    try {
      await importProvider({
        provider: {
          slug: effectiveSlug,
          name: name.trim(),
          npm,
          env: envVars,
          api: needsApiBase ? apiBase.trim() : undefined,
          enabled: true,
        },
        models: [],
      });
      toast.success(`Created ${name.trim()}. Add models from the model manager.`);
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create provider.");
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
            <DialogTitle>Custom provider</DialogTitle>
            <DialogDescription>
              Connect a provider that isn’t on models.dev. Add models afterwards.
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="max-h-[60svh] overflow-y-auto border-y px-6 py-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="custom-name">Name</FieldLabel>
            <Input
              id="custom-name"
              placeholder="My Gateway"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="custom-slug">Slug</FieldLabel>
            <Input
              id="custom-slug"
              placeholder="my-gateway"
              value={effectiveSlug}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(slugify(event.target.value));
              }}
            />
            <FieldDescription>
              {duplicate
                ? "A provider with this slug already exists."
                : "Stable identifier used by the gateway and billing."}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="custom-npm">SDK package</FieldLabel>
            <Select value={npm} onValueChange={(value) => changeNpm(value as AIProviderNpmPackage)}>
              <SelectTrigger id="custom-npm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_NPM.map((pkg) => (
                  <SelectItem key={pkg} value={pkg}>
                    {pkg}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {needsApiBase && (
            <Field>
              <FieldLabel htmlFor="custom-api">Base URL</FieldLabel>
              <Input
                id="custom-api"
                placeholder="https://api.example.com/v1"
                value={apiBase}
                onChange={(event) => setApiBase(event.target.value)}
              />
              <FieldDescription>
                Required for OpenAI-compatible providers.
              </FieldDescription>
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="custom-env">Credential variables</FieldLabel>
            <Input
              id="custom-env"
              placeholder="API_KEY"
              value={env}
              onChange={(event) => setEnv(event.target.value)}
            />
            <FieldDescription>
              Comma-separated env names users provide as BYOK keys. Leave blank if none.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </div>

      <DialogFooter className="p-4">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button onClick={submit} disabled={submitting || !valid}>
          {submitting && <Spinner data-icon="inline-start" />}
          Create provider
        </Button>
      </DialogFooter>
    </>
  );
}
