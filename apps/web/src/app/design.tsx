import { createFileRoute } from "@tanstack/react-router";

import { DesignShowcase } from "@/components/design/design-showcase";

export const Route = createFileRoute("/design")({
  staticData: {
    pageTitle: "Design",
    shell: "bare",
  },
  component: DesignShowcase,
});
