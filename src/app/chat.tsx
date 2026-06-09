import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/chat")({
  component: ChatPage,
});

function ChatPage() {
  return (
    <main className="flex min-h-[calc(100svh-var(--header-height))] flex-col gap-6 p-4 md:p-8">
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end rounded-xl border bg-card p-4 shadow-sm md:p-6">
        <div className="flex flex-1 items-center justify-center text-center text-muted-foreground">
          <div className="flex max-w-sm flex-col gap-2">
            <h1 className="text-2xl font-semibold text-foreground">Radium Chat</h1>
            <p className="text-sm">
              Start a conversation with your configured AI providers.
            </p>
          </div>
        </div>
        <form className="flex gap-2 rounded-lg border bg-background p-2">
          <Input
            className="border-0 bg-transparent shadow-none focus-visible:ring-0"
            placeholder="Ask Radium anything..."
            type="text"
          />
          <Button type="button">
            Send
          </Button>
        </form>
      </section>
    </main>
  );
}
