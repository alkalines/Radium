/**
 * Where this web server reaches packages/server: the `/api` proxy, the WebSocket relay and SSR
 * calls. Server-only (`SERVER_URL`, never `VITE_*`); browsers always use the page's own origin.
 */
export function serverOrigin(): string {
  return process.env.SERVER_URL ?? "http://localhost:3001";
}
