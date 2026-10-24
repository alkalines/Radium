import "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Short title shown in the site header while this route is active. */
    pageTitle?: string;
    /**
     * `"bare"` renders the route without the legacy sidebar shell, for screens that bring their
     * own harness Window (docs/Interface_Design.md §4). Defaults to the app shell.
     */
    shell?: "app" | "bare";
  }
}
