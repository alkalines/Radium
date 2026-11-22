import { useEffect, useState } from "react";
import type { Id } from "backend/convex/_generated/dataModel";
import { useKeyStatus } from "./use-key-status";
import { openLegacyContent, type SealedLegacyBox } from "./legacy-content";
import { secretGeneration } from "./runtime";

type NamedRow = { id: string; name: string; icon?: string | null; legacyContent?: SealedLegacyBox | null };

/** Decrypted display names stay in component memory and disappear synchronously on lock/input changes. */
export function useDecryptedNames<T extends NamedRow>(rows: readonly T[], table: "workspaces" | "projects", workspace?: Id<"workspaces">): T[] {
  const status = useKeyStatus();
  const generation = secretGeneration();
  const [opened, setOpened] = useState<{ source: readonly T[]; generation: number; rows: T[] }>();
  useEffect(() => {
    let active = true;
    setOpened(undefined);
    if (status.state !== "unlocked" || !rows.some(row => row.legacyContent)) return;
    void Promise.all(rows.map(async row => {
      if (!row.legacyContent || row.legacyContent.kind === "custody") return row;
      try {
        const value = await openLegacyContent<{ name?: unknown; icon?: unknown }>(row.legacyContent, {
          table, record: row.id, workspace: table === "workspaces" ? row.id as Id<"workspaces"> : workspace,
        });
        if (typeof value.name !== "string" || (value.icon !== undefined && typeof value.icon !== "string")) throw new Error("Invalid encrypted name");
        return { ...row, name: value.name, icon: (value.icon as string | undefined) ?? null };
      } catch { return { ...row, name: "Encrypted name", icon: null }; }
    })).then(result => {
      if (active && generation === secretGeneration()) setOpened({ source: rows, generation, rows: result });
    });
    return () => { active = false; };
  }, [rows, table, workspace, status, generation]);
  if (status.state === "unlocked" && opened?.source === rows && opened.generation === generation) return opened.rows;
  return rows.map(row => row.legacyContent
    ? { ...row, name: row.legacyContent.kind === "custody" ? "Not yet end-to-end encrypted" : "Encrypted name", icon: null }
    : row);
}
