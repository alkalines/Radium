import type { App } from "../src/app";

/**
 * One read through the `/api/streams` proxy, as a browser or Worker would make it: a long-poll,
 * or with `live: false` a catch-up read that answers at once.
 */
export async function readOnce(app: App, headers: Headers, path: string, offset: string, live = true) {
  const query = new URLSearchParams({ offset });
  if (live) query.set("live", "long-poll");
  const response = await app.request(`/api/streams/${path}?${query}`, { headers });
  const messages = response.status === 200 ? ((await response.json()) as unknown[]) : [];
  if (response.status !== 200 && response.status !== 204) {
    return { status: response.status, messages, nextOffset: offset, closed: false };
  }
  return {
    status: response.status,
    messages,
    nextOffset: response.headers.get("stream-next-offset") ?? offset,
    closed: response.headers.get("stream-closed") === "true",
  };
}

/** Reads `path` from the start until the writer closes it; throws if it does not within `timeoutMs`. */
export async function readToEnd(app: App, headers: Headers, path: string, timeoutMs = 15_000) {
  const messages: unknown[] = [];
  let offset = "-1";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await readOnce(app, headers, path, offset);
    if (page.status !== 200 && page.status !== 204) throw new Error(`Stream read answered ${page.status}`);
    messages.push(...page.messages);
    offset = page.nextOffset;
    if (page.closed) return messages;
  }
  throw new Error("The stream was not closed in time");
}

/** Waits for the first messages after `offset` (long-poll), at most `timeoutMs`. */
export async function readNext(app: App, headers: Headers, path: string, offset: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await readOnce(app, headers, path, offset);
    if (page.status !== 200 && page.status !== 204) throw new Error(`Stream read answered ${page.status}`);
    if (page.messages.length > 0 || page.closed) return page;
    offset = page.nextOffset;
  }
  throw new Error("No message arrived in time");
}

/** Polls `condition` until it holds (deferred work after a response), at most `timeoutMs`. */
export async function eventually<T>(condition: () => Promise<T | null | undefined | false>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error("The condition did not hold in time");
}
