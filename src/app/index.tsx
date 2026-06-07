import { createFileRoute } from "@tanstack/react-router"; // [!code ++]

export const Route = createFileRoute("/")({
  // [!code ++]
  component: Home, // [!code ++]
});

function Home() {
  return (
    <div className="min-h-[calc(100svh-var(--header-height))] w-full flex items-center justify-center flex-col gap-4 p-4">
      <img
        className="max-w-sm w-full"
        src="https://raw.githubusercontent.com/TanStack/tanstack.com/main/public/images/logos/splash-dark.png"
        alt="TanStack Logo"
      />
      <h1>
        <span className="line-through">Next.js</span> TanStack Start
      </h1>
      <a
        className="bg-foreground text-background rounded-full px-4 py-1 hover:opacity-90"
        href="https://tanstack.com/start/latest"
        target="_blank"
      >
        Docs
      </a>
    </div>
  );
}
