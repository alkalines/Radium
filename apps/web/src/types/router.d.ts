import "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Short title shown in the site header while this route is active. */
    pageTitle?: string;
  }
}
