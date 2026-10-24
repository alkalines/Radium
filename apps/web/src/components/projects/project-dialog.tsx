import { type FormEvent, useId, useRef, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon, StarIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { validChatWorkerDirectory } from "backend/src/worker/chat-config";
import { TileAppearanceFields } from "@/components/harness/tile-appearance-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkerPresence, useWorkerPresenceClock } from "@/components/workspaces/worker-presence";
import { cn } from "@/lib/utils";
import { ProjectGlyph, type ProjectSummary } from "./project-glyph";

/** Matches the backend's Project name limit. */
const maxNameLength = 80;

/** Matches the backend's cap on Worker folders per Project. */
const maxFolders = 20;

type WorkerList = FunctionReturnType<typeof api.workers.list>;

/** One editable Worker folder; `key` stays stable while the row's Worker changes. */
type FolderRow = { key: string; workerId: string; directory: string; isInvalid: boolean };

/**
 * Create or edit a Project (`docs/Interface_Design.md`, Project): name, tile color and icon, and,
 * for workspace owners, the Project's Workers: one absolute folder per Worker and an optional
 * default Worker. Without `project` it creates one in `workspaceId` and reports the new id
 * through `onCreated`. Also opened from the Run target picker's `+ Add project`, so the props
 * stay stable. The backend re-checks every permission (folders are owner-only); failures are
 * toasts.
 */
export function ProjectDialog({
  open,
  onOpenChange,
  workspaceId,
  isOwner,
  project,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: Id<"workspaces">;
  /** Workspace owners may set Worker folders; members never query Workers. */
  isOwner: boolean;
  /** The Project to edit; omit to create one. */
  project?: ProjectSummary;
  onCreated?: (project: Id<"projects">) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open, so every opening starts from the Project's saved values. */}
        <ProjectForm
          workspaceId={workspaceId}
          isOwner={isOwner}
          project={project}
          onDone={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  );
}

function ProjectForm({
  workspaceId,
  isOwner,
  project,
  onDone,
  onCreated,
}: {
  workspaceId: Id<"workspaces">;
  isOwner: boolean;
  project?: ProjectSummary;
  onDone: () => void;
  onCreated?: (project: Id<"projects">) => void;
}) {
  const formId = useId();
  const savedFolders = project?.folders ?? [];
  const savedDefaultWorkerId = project?.defaultWorkerId;

  const [name, setName] = useState(project?.name ?? "");
  const [color, setColor] = useState(project?.color);
  const [icon, setIcon] = useState(project?.icon);
  const [rows, setRows] = useState<FolderRow[]>(() =>
    savedFolders.map((folder) => ({
      key: `saved-${folder.workerId}`,
      workerId: folder.workerId,
      directory: folder.directory,
      isInvalid: false,
    })),
  );
  const [defaultWorkerId, setDefaultWorkerId] = useState(savedDefaultWorkerId);
  const [isSaving, setIsSaving] = useState(false);
  const nextRowKey = useRef(0);

  const createProject = useMutation(api.projects.create);
  const updateProject = useMutation(api.projects.update);
  // Worker identities are owner-only; members never see the Workers section.
  const { data: workersData } = useQuery(
    convexQuery(api.workers.list, isOwner ? { workspace: workspaceId } : "skip"),
  );

  const trimmedName = name.trim();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedName || isSaving) return;

    const folders = rows.map((row) => ({
      workerId: row.workerId,
      directory: row.directory.trim(),
    }));
    const invalidKeys = new Set(
      rows.filter((row) => !validChatWorkerDirectory(row.directory.trim())).map((row) => row.key),
    );
    if (isOwner && invalidKeys.size > 0) {
      setRows((current) => current.map((row) => ({ ...row, isInvalid: invalidKeys.has(row.key) })));
      return;
    }
    const nextDefault = effectiveDefaultWorkerId(rows, defaultWorkerId);

    setIsSaving(true);
    try {
      if (project) {
        // Only send folder settings when they changed: members may not touch them, and an
        // unchanged folder on a since-revoked Worker would otherwise reject an unrelated rename.
        const areFoldersChanged =
          isOwner &&
          (folders.length !== savedFolders.length ||
            folders.some(
              (folder, index) =>
                folder.workerId !== savedFolders[index]!.workerId ||
                folder.directory !== savedFolders[index]!.directory,
            ));
        const isDefaultChanged = isOwner && nextDefault !== savedDefaultWorkerId;
        await updateProject({
          project: project._id,
          name: trimmedName,
          color,
          icon,
          ...(areFoldersChanged ? { folders } : {}),
          ...(isDefaultChanged ? { defaultWorkerId: nextDefault ?? null } : {}),
        });
        toast.success("Project saved.");
      } else {
        const created = await createProject({
          workspace: workspaceId,
          name: trimmedName,
          color,
          icon,
          ...(isOwner && folders.length > 0 ? { folders, defaultWorkerId: nextDefault } : {}),
        });
        toast.success("Project created.");
        onCreated?.(created);
      }
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the project.");
    } finally {
      setIsSaving(false);
    }
  }

  function addRow(workerId: string) {
    nextRowKey.current += 1;
    const key = `new-${nextRowKey.current}`;
    setRows((current) => [...current, { key, workerId, directory: "", isInvalid: false }]);
  }

  function updateRow(key: string, change: Partial<Omit<FolderRow, "key">>) {
    const previous = rows.find((row) => row.key === key);
    // The default follows its row when the row switches to another Worker.
    if (previous && change.workerId && previous.workerId === defaultWorkerId) {
      setDefaultWorkerId(change.workerId);
    }
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function removeRow(key: string) {
    const removed = rows.find((row) => row.key === key);
    if (removed?.workerId === defaultWorkerId) setDefaultWorkerId(undefined);
    setRows((current) => current.filter((row) => row.key !== key));
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="contents">
      <DialogHeader>
        <DialogTitle>{project ? "Edit project" : "New project"}</DialogTitle>
        <DialogDescription>A folder for related sessions in this workspace.</DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <div className="flex h-10 items-center gap-2.5 rounded-xl bg-muted px-3 text-sm">
          <ProjectGlyph project={{ color, icon }} />
          {trimmedName ? (
            <span className="truncate">{trimmedName}</span>
          ) : (
            <span className="truncate text-muted-foreground">Untitled project</span>
          )}
        </div>

        <Field>
          <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
          <Input
            id={`${formId}-name`}
            value={name}
            maxLength={maxNameLength}
            autoFocus
            autoComplete="off"
            required
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field>
          <FieldTitle>Appearance</FieldTitle>
          <TileAppearanceFields
            color={color}
            icon={icon}
            disabled={isSaving}
            onColorChange={setColor}
            onIconChange={setIcon}
          />
        </Field>

        {isOwner ? (
          <WorkerFoldersField
            rows={rows}
            workers={workersData}
            defaultWorkerId={effectiveDefaultWorkerId(rows, defaultWorkerId)}
            disabled={isSaving}
            onAdd={addRow}
            onChange={updateRow}
            onRemove={removeRow}
            onDefaultChange={setDefaultWorkerId}
          />
        ) : null}

        <p className="text-xs text-muted-foreground">
          Favicon icons and project usage totals are planned.
        </p>
      </FieldGroup>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={isSaving || !trimmedName}>
          {project ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The default Worker that will be saved: the only row's Worker, or the marked one while it is
 * still listed. With several rows and no mark there is no default.
 */
function effectiveDefaultWorkerId(rows: FolderRow[], marked: string | undefined) {
  if (rows.length === 1) return rows[0]!.workerId;
  return rows.some((row) => row.workerId === marked) ? marked : undefined;
}

/**
 * Owner-only Workers section: one row per Worker (Worker select with online state, absolute
 * folder on that Worker, default mark, remove). A Worker appears in at most one row; Workers
 * revoked since stay in their row as unavailable so the owner can remove them.
 */
function WorkerFoldersField({
  rows,
  workers,
  defaultWorkerId,
  disabled,
  onAdd,
  onChange,
  onRemove,
  onDefaultChange,
}: {
  rows: FolderRow[];
  /** `undefined` while loading. */
  workers: WorkerList | undefined;
  defaultWorkerId: string | undefined;
  disabled: boolean;
  onAdd: (workerId: string) => void;
  onChange: (key: string, change: Partial<Omit<FolderRow, "key">>) => void;
  onRemove: (key: string) => void;
  onDefaultChange: (workerId: string | undefined) => void;
}) {
  const now = useWorkerPresenceClock();
  const activeWorkers = (workers ?? []).filter((worker) => worker.status === "active");
  const usedWorkerIds = new Set(rows.map((row) => row.workerId));
  const unusedWorkers = activeWorkers.filter((worker) => !usedWorkerIds.has(worker.workerId));
  const hasInvalidRow = rows.some((row) => row.isInvalid);

  let description =
    "New sessions in this project start on the default Worker (or the only one) when it is online. Picking another Worker listed here uses its folder.";
  if (hasInvalidRow) {
    description = "Enter an absolute path on each Worker.";
  } else if (workers !== undefined && activeWorkers.length === 0) {
    description = "Enroll a Worker in Settings → Workers to give this project a folder.";
  }

  return (
    <Field>
      <FieldTitle>Workers</FieldTitle>
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const isDefault = row.workerId === defaultWorkerId;
            const isOnlyRow = rows.length === 1;
            const isRowWorkerActive = activeWorkers.some(
              (worker) => worker.workerId === row.workerId,
            );
            // This row's Worker plus every active Worker no other row uses.
            const options = activeWorkers.filter(
              (worker) => worker.workerId === row.workerId || !usedWorkerIds.has(worker.workerId),
            );

            let defaultTitle = "Make default Worker";
            if (isOnlyRow) {
              defaultTitle = "The only Worker is the default";
            } else if (isDefault) {
              defaultTitle = "Default Worker";
            }

            return (
              <li key={row.key} className="flex items-center gap-2">
                <Select
                  value={row.workerId}
                  disabled={disabled}
                  onValueChange={(workerId) => onChange(row.key, { workerId })}
                >
                  <SelectTrigger aria-label="Worker" className="w-44 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((worker) => (
                      <SelectItem key={worker.workerId} value={worker.workerId}>
                        <span className="truncate">{worker.name}</span>
                        <WorkerPresence lastSeenAt={worker.lastSeenAt} now={now} />
                      </SelectItem>
                    ))}
                    {isRowWorkerActive ? null : (
                      <SelectItem value={row.workerId} disabled>
                        {workers === undefined ? "Loading Workers…" : "Worker unavailable"}
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <Input
                  aria-label="Absolute path on the Worker"
                  autoComplete="off"
                  spellCheck={false}
                  value={row.directory}
                  placeholder="/absolute/project/path"
                  aria-invalid={row.isInvalid}
                  disabled={disabled}
                  className="min-w-0 flex-1 font-mono text-[13px]"
                  onChange={(event) =>
                    onChange(row.key, { directory: event.target.value, isInvalid: false })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Default Worker"
                  aria-pressed={isDefault}
                  title={defaultTitle}
                  // The only row is the default by definition; there is nothing to toggle.
                  disabled={disabled || isOnlyRow}
                  className={cn(isDefault && "text-foreground disabled:opacity-100")}
                  onClick={() => onDefaultChange(isDefault ? undefined : row.workerId)}
                >
                  <StarIcon className={cn(isDefault && "fill-current")} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove Worker"
                  title="Remove Worker"
                  disabled={disabled}
                  onClick={() => onRemove(row.key)}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || unusedWorkers.length === 0 || rows.length >= maxFolders}
          onClick={() => {
            const next = unusedWorkers[0];
            if (next) onAdd(next.workerId);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          Add Worker
        </Button>
      </div>
      <FieldDescription className={cn(hasInvalidRow && "text-destructive")}>
        {description}
      </FieldDescription>
    </Field>
  );
}
