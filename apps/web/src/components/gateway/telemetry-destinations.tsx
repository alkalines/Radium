import { useId, useMemo, useState, type FormEvent } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PencilIcon, PlusIcon, SendIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";

type Destination = FunctionReturnType<
  typeof api.observability.telemetryExport.listDestinations
>[number];
type ListedKey = FunctionReturnType<typeof api.keys.listKeys>[number];
type WorkspaceKey = Extract<ListedKey, { source: "workspace" }>;
type Kind = Destination["kind"];
type HeaderRow = { name: string; value: string };

const kindLabels: Record<Kind, string> = { otlp: "OTLP/HTTP", webhook: "Webhook" };

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function deliveryStatus(destination: Destination) {
  if (destination.lastError) return `Last delivery failed: ${destination.lastError}`;
  if (destination.lastDeliveryAt) {
    return `Last delivered ${new Date(destination.lastDeliveryAt).toLocaleString()}`;
  }
  return "No deliveries yet";
}

/**
 * Export destinations for the workspace's Gateway telemetry (owner only; the route gates
 * members). Each destination receives every captured request as an OTLP/JSON trace, either
 * through the OTLP/HTTP path or posted as-is to a webhook. Header values are write-only: the
 * list only reports that headers are stored.
 */
export function TelemetryDestinations({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const { data: destinations } = useQuery(
    convexQuery(api.observability.telemetryExport.listDestinations, { workspace: workspaceId }),
  );
  const updateDestination = useMutation(api.observability.telemetryExport.updateDestination);
  const testDestination = useAction(api.observability.telemetryExport.testDestination);

  const [editing, setEditing] = useState<Destination | "new" | null>(null);
  const [deleting, setDeleting] = useState<Destination | null>(null);
  const [testing, setTesting] = useState<Id<"telemetry_destinations"> | null>(null);

  async function toggle(destination: Destination, enabled: boolean) {
    try {
      await updateDestination({ workspace: workspaceId, destination: destination._id, enabled });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to update the destination."));
    }
  }

  async function test(destination: Destination) {
    setTesting(destination._id);
    try {
      const result = await testDestination({
        workspace: workspaceId,
        destination: destination._id,
      });
      if (result.ok) toast.success(`Test span delivered to ${destination.name}.`);
      else toast.error(`Test failed: ${result.error}`);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to send the test span."));
    } finally {
      setTesting(null);
    }
  }

  return (
    <>
      <GroupList
        title="Export destinations"
        description="Send captured requests to an OpenTelemetry collector or a webhook."
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            <PlusIcon data-icon="inline-start" />
            Add destination
          </Button>
        }
      >
        {destinations === undefined ? (
          <RowBlock>
            <Skeleton className="h-6" />
          </RowBlock>
        ) : destinations.length === 0 ? (
          <RowBlock>
            <p className="text-sm text-muted-foreground">No destinations configured.</p>
          </RowBlock>
        ) : (
          destinations.map((destination) => (
            <Row
              key={destination._id}
              title={destination.name}
              tag={kindLabels[destination.kind]}
              description={
                <>
                  <span className="font-mono text-xs">{destination.endpoint}</span>
                  {" · "}
                  <span className={destination.lastError ? "text-destructive" : undefined}>
                    {deliveryStatus(destination)}
                  </span>
                </>
              }
            >
              <Switch
                aria-label={`${destination.enabled ? "Disable" : "Enable"} ${destination.name}`}
                checked={destination.enabled}
                onCheckedChange={(checked) => void toggle(destination, checked)}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Send a test span to ${destination.name}`}
                disabled={testing === destination._id}
                onClick={() => void test(destination)}
              >
                {testing === destination._id ? <Spinner /> : <SendIcon />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Edit ${destination.name}`}
                onClick={() => setEditing(destination)}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Delete ${destination.name}`}
                onClick={() => setDeleting(destination)}
              >
                <Trash2Icon />
              </Button>
            </Row>
          ))
        )}
      </GroupList>

      <DestinationDialog
        // Remount per target so form state always starts from the destination being edited.
        key={editing === null ? "closed" : editing === "new" ? "new" : editing._id}
        workspaceId={workspaceId}
        target={editing}
        onOpenChange={(open) => !open && setEditing(null)}
      />
      <DeleteDestinationDialog
        workspaceId={workspaceId}
        target={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </>
  );
}

function DestinationDialog({
  workspaceId,
  target,
  onOpenChange,
}: {
  workspaceId: Id<"workspaces">;
  target: Destination | "new" | null;
  onOpenChange: (open: boolean) => void;
}) {
  const existing = target !== null && target !== "new" ? target : null;
  const fieldId = useId();
  const createDestination = useMutation(api.observability.telemetryExport.createDestination);
  const updateDestination = useMutation(api.observability.telemetryExport.updateDestination);
  const { data: keys } = useQuery(convexQuery(api.keys.listKeys, { workspace: workspaceId }));
  // Legacy keys are not Gateway API key rows and cannot be targeted by a destination.
  const apiKeys = useMemo(
    () => keys?.filter((key): key is WorkspaceKey => key.source === "workspace") ?? [],
    [keys],
  );

  const [kind, setKind] = useState<Kind>(existing?.kind ?? "otlp");
  const [name, setName] = useState(existing?.name ?? "");
  const [endpoint, setEndpoint] = useState(existing?.endpoint ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [privacyMode, setPrivacyMode] = useState(existing?.privacyMode ?? false);
  const [sampling, setSampling] = useState(String(Math.round((existing?.samplingRate ?? 1) * 100)));
  const [include, setInclude] = useState<Id<"api_keys">[]>(existing?.includeApiKeys ?? []);
  const [exclude, setExclude] = useState<Id<"api_keys">[]>(existing?.excludeApiKeys ?? []);
  const [replaceHeaders, setReplaceHeaders] = useState(!existing?.hasHeaders);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const samplingPercent = Number(sampling);
  const samplingValid =
    sampling.trim() !== "" &&
    Number.isFinite(samplingPercent) &&
    samplingPercent >= 0 &&
    samplingPercent <= 100;
  const canSubmit = name.trim() !== "" && endpoint.trim() !== "" && samplingValid;

  function toggleKey(list: "include" | "exclude", id: Id<"api_keys">, checked: boolean) {
    const [setThis, setOther] =
      list === "include" ? [setInclude, setExclude] : [setExclude, setInclude];
    setThis((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
    // Exclude wins on the server, so the form keeps the two lists disjoint.
    if (checked) setOther((current) => current.filter((item) => item !== id));
  }

  function updateHeader(index: number, patch: Partial<HeaderRow>) {
    setHeaders((rows) =>
      rows.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    const headerMap = Object.fromEntries(
      headers.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value]),
    );
    const settings = {
      name: name.trim(),
      endpoint: endpoint.trim(),
      enabled,
      privacyMode,
      samplingRate: samplingPercent / 100,
      includeApiKeys: include,
      excludeApiKeys: exclude,
    };

    setSubmitting(true);
    try {
      if (existing) {
        await updateDestination({
          workspace: workspaceId,
          destination: existing._id,
          ...settings,
          ...(replaceHeaders ? { headers: headerMap } : {}),
        });
        toast.success("Destination updated.");
      } else {
        await createDestination({ workspace: workspaceId, kind, ...settings, headers: headerMap });
        toast.success("Destination added.");
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to save the destination."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? "Edit destination" : "Add destination"}</DialogTitle>
            <DialogDescription>
              Requests are sent as OTLP/JSON traces after they are captured. Telemetry capture and
              content recording are configured separately.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-kind`}>Type</FieldLabel>
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as Kind)}
                disabled={existing !== null}
              >
                <SelectTrigger id={`${fieldId}-kind`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="otlp">OTLP/HTTP</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-name`}>Name</FieldLabel>
              <Input
                id={`${fieldId}-name`}
                autoComplete="off"
                placeholder="Langfuse"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-endpoint`}>Endpoint</FieldLabel>
              <Input
                id={`${fieldId}-endpoint`}
                autoComplete="off"
                className="font-mono text-[13px]"
                placeholder={
                  kind === "otlp"
                    ? "https://collector.example.com"
                    : "https://hooks.example.com/radium"
                }
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
              />
              <FieldDescription>
                {kind === "otlp"
                  ? "/v1/traces is appended unless the URL already ends with it. "
                  : "Posted to as configured. "}
                HTTPS is required; plain HTTP works for localhost only.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Headers</FieldLabel>
              {existing?.hasHeaders && !replaceHeaders ? (
                <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>Stored headers are hidden and kept as they are.</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setReplaceHeaders(true)}
                  >
                    Replace
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {headers.map((row, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        aria-label="Header name"
                        autoComplete="off"
                        placeholder="Authorization"
                        value={row.name}
                        onChange={(event) => updateHeader(index, { name: event.target.value })}
                      />
                      <Input
                        aria-label="Header value"
                        type="password"
                        autoComplete="off"
                        placeholder="Value"
                        value={row.value}
                        onChange={(event) => updateHeader(index, { value: event.target.value })}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove header"
                        onClick={() =>
                          setHeaders((rows) => rows.filter((_, position) => position !== index))
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setHeaders((rows) => [...rows, { name: "", value: "" }])}
                    >
                      <PlusIcon data-icon="inline-start" />
                      Add header
                    </Button>
                    {existing?.hasHeaders ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setReplaceHeaders(false)}
                      >
                        Keep stored headers
                      </Button>
                    ) : null}
                  </div>
                  {existing?.hasHeaders ? (
                    <FieldDescription>
                      Saving replaces all stored headers; leave the list empty to remove them.
                    </FieldDescription>
                  ) : null}
                </div>
              )}
            </Field>

            <Field orientation="horizontal">
              <Switch id={`${fieldId}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
              <FieldLabel htmlFor={`${fieldId}-enabled`}>Enabled</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Switch
                id={`${fieldId}-privacy`}
                checked={privacyMode}
                onCheckedChange={setPrivacyMode}
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor={`${fieldId}-privacy`}>Privacy mode</FieldLabel>
                <FieldDescription>
                  Leave out messages, system instructions, tool definitions, and output.
                </FieldDescription>
              </div>
            </Field>

            <Field>
              <FieldLabel htmlFor={`${fieldId}-sampling`}>Sampling (%)</FieldLabel>
              <Input
                id={`${fieldId}-sampling`}
                type="number"
                min={0}
                max={100}
                step={1}
                inputMode="numeric"
                aria-invalid={!samplingValid}
                value={sampling}
                onChange={(event) => setSampling(event.target.value)}
              />
              <FieldDescription>
                Decided per session, so a sampled session is exported in full.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>API keys</FieldLabel>
              {apiKeys.length === 0 ? (
                <FieldDescription>
                  {keys === undefined
                    ? "Loading keys…"
                    : "No API keys yet, so every request matches."}
                </FieldDescription>
              ) : (
                <>
                  <ul className="rounded-lg border px-3">
                    <li className="flex items-center gap-3 border-b py-2 text-xs text-muted-foreground">
                      <span className="flex-1">Key</span>
                      <span className="w-14 text-center">Only</span>
                      <span className="w-14 text-center">Skip</span>
                    </li>
                    {apiKeys.map((key) => (
                      <li
                        key={key._id}
                        className="flex items-center gap-3 border-b py-2 last:border-b-0"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{key.name}</span>
                        <span className="flex w-14 justify-center">
                          <Checkbox
                            aria-label={`Only export requests from ${key.name}`}
                            checked={include.includes(key._id)}
                            onCheckedChange={(checked) =>
                              toggleKey("include", key._id, checked === true)
                            }
                          />
                        </span>
                        <span className="flex w-14 justify-center">
                          <Checkbox
                            aria-label={`Skip requests from ${key.name}`}
                            checked={exclude.includes(key._id)}
                            onCheckedChange={(checked) =>
                              toggleKey("exclude", key._id, checked === true)
                            }
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                  <FieldDescription>
                    With no key marked Only, every key is exported. Skipped keys are never exported.
                  </FieldDescription>
                </>
              )}
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !canSubmit}>
              {submitting && <Spinner data-icon="inline-start" />}
              {existing ? "Save changes" : "Add destination"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDestinationDialog({
  workspaceId,
  target,
  onOpenChange,
}: {
  workspaceId: Id<"workspaces">;
  target: Destination | null;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteDestination = useMutation(api.observability.telemetryExport.deleteDestination);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (!target) return;
    setSubmitting(true);
    try {
      await deleteDestination({ workspace: workspaceId, destination: target._id });
      toast.success(`Deleted ${target.name}.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to delete the destination."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {target?.name}?</DialogTitle>
          <DialogDescription>
            Requests stop being exported there and its stored headers are removed. Data already
            delivered is not affected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting && <Spinner data-icon="inline-start" />}
            Delete destination
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
