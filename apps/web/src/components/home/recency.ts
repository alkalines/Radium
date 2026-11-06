const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const week = 7 * day;

type SessionGroup<T> = { label: string; sessions: T[] };

/** Pinned first, then Today / Yesterday / Older by local day. */
export function groupByRecency<T>(
  sessions: T[],
  now: number,
  timestamp: (session: T) => number,
  pinned: (session: T) => boolean = () => false,
): SessionGroup<T>[] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday - day;
  const groups: SessionGroup<T>[] = [
    { label: "Pinned", sessions: [] },
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Older", sessions: [] },
  ];
  for (const session of sessions) {
    if (pinned(session)) groups[0].sessions.push(session);
    else if (timestamp(session) >= startOfToday) groups[1].sessions.push(session);
    else if (timestamp(session) >= startOfYesterday) groups[2].sessions.push(session);
    else groups[3].sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}

/** Compact age, then a short date once older than a month. */
export function formatRelativeTime(timestamp: number, now: number) {
  const age = Math.max(0, now - timestamp);
  if (age < minute) return "now";
  if (age < hour) return `${Math.floor(age / minute)}m`;
  if (age < day) return `${Math.floor(age / hour)}h`;
  if (age < week) return `${Math.floor(age / day)}d`;
  if (age < 5 * week) return `${Math.floor(age / week)}w`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
