import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  staticData: {
    pageTitle: "Home",
  },
  loader: () => {
    throw redirect({ to: "/chat" });
  },
});
