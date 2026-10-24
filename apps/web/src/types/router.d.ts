import "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Document title segment for this route. */
    pageTitle?: string;
    /**
     * `"bare"` renders the route without the harness Window (auth screens, the `/design`
     * reference, which brings its own Window). Defaults to the Window.
     */
    shell?: "window" | "bare";
    /**
     * Which Window screen owns the Panel (`docs/Interface_Design.md` §4). `home` connects the
     * Home tab; `session` hands the Panel to the open session Tabs, which the Window keeps mounted
     * itself (the route component renders nothing); `settings` wraps the route in the Settings
     * sidebar and connects no Tab. Unset routes render plainly in the Panel.
     */
    screen?: "home" | "session" | "settings";
    /**
     * Settings pages whose content is a wide table (Activity, Telemetry) opt out of the 760px
     * settings column.
     */
    settingsWidth?: "wide";
  }
}
