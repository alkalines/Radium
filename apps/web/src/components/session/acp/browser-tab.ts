const storageKey = "radium:acp-browser-tab";
let browserTabId: string | undefined;

/** One viewer identity per browser tab, shared by every ACP Session in that tab. */
export function acpBrowserTabId(): string {
  if (browserTabId) return browserTabId;
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved && saved.length <= 64) return (browserTabId = saved);
  } catch {
    // Storage can be unavailable in private or embedded browsing contexts.
  }
  browserTabId = crypto.randomUUID();
  try {
    sessionStorage.setItem(storageKey, browserTabId);
  } catch {
    // The in-memory identity still lasts for this page's lifetime.
  }
  return browserTabId;
}
