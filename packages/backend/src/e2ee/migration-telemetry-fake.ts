// Test-only in-memory database for the telemetry migration suites (not a `*.test.ts` file).

export type Row = Record<string, unknown>;
export type Fake = {
  tables: Record<string, Row[]>;
  scheduled: Array<{ name: unknown; args: unknown }>;
  db: unknown;
  scheduler: unknown;
};
type Bound = { eq: (field: string, value: unknown) => Bound };

function field(row: Row, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Row | undefined)?.[key], row);
}

/** Convex index order: indexed equality fields, then `_creationTime`, then `_id`. */
function ordered(rows: Row[]) {
  return [...rows].sort((a, b) =>
    (a._creationTime as number) - (b._creationTime as number) || String(a._id).localeCompare(String(b._id)));
}

function cursorable(rows: Row[]) {
  return {
    take: async (count: number) => rows.slice(0, count),
    first: async () => rows[0] ?? null,
    unique: async () => rows[0] ?? null,
    /** Opaque offset cursor over the stable (time, id) order, like Convex's paginate. */
    paginate: async ({ numItems, cursor }: { numItems: number; cursor: string | null }) => {
      const start = cursor ? Number(cursor) : 0;
      const end = start + numItems;
      return { page: rows.slice(start, end), isDone: end >= rows.length, continueCursor: String(end) };
    },
  };
}

/** Rows without an explicit `_creationTime` get increasing ones; pass equal times to test ties. */
export function fakeDb(tables: Record<string, Row[]>): Fake {
  let nextId = 0;
  let clock = 0;
  for (const rows of Object.values(tables)) rows.forEach((row) => { row._creationTime ??= ++clock; });
  const scheduled: Fake["scheduled"] = [];
  return {
    tables,
    scheduled,
    scheduler: { runAfter: async (_delay: number, name: unknown, args: unknown) => { scheduled.push({ name, args }); } },
    db: {
      get: async (table: string, id: string) => tables[table]?.find((row) => row._id === id) ?? null,
      insert: async (table: string, doc: Row) => {
        const _id = `${table}:new${++nextId}`;
        (tables[table] ??= []).push({ ...doc, _id, _creationTime: ++clock + 1_000_000 });
        return _id;
      },
      replace: async (table: string, id: string, doc: Row) => {
        const rows = tables[table]!;
        const index = rows.findIndex((row) => row._id === id);
        rows[index] = { ...doc, _id: id, _creationTime: rows[index]!._creationTime };
      },
      patch: async (table: string, id: string, doc: Row) => {
        const row = tables[table]!.find((candidate) => candidate._id === id)!;
        for (const [key, value] of Object.entries(doc)) {
          if (value === undefined) delete row[key];
          else row[key] = value;
        }
      },
      delete: async (table: string, id: string) => {
        tables[table] = tables[table]!.filter((row) => row._id !== id);
      },
      query: (table: string) => ({
        ...cursorable(ordered(tables[table] ?? [])),
        withIndex(_name: string, build: (q: Bound) => unknown) {
          const filters: Array<[string, unknown]> = [];
          const q: Bound = { eq: (path, value) => { filters.push([path, value]); return q; } };
          build(q);
          return cursorable(ordered((tables[table] ?? []).filter((row) => filters.every(([path, value]) => field(row, path) === value))));
        },
      }),
    },
  };
}
