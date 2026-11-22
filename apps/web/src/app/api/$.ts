import { createFileRoute } from "@tanstack/react-router";
import { forwardToBackend } from "@/lib/backend-forwarder";

const forward = ({ request }: { request: Request }) => forwardToBackend(request);

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: forward,
      POST: forward,
      PUT: forward,
      PATCH: forward,
      DELETE: forward,
      HEAD: forward,
      OPTIONS: forward,
    },
  },
});
