import React from "react";

export default function ChatPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h3 className="text-sm text-gray-500 dark:text-gray-400">Channel</h3>
        <h1 className="text-2xl font-semibold">General</h1>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
          Static preview of the Radium chat. Integrations and real-time behavior
          will be added later.
        </p>
      </header>

      <section className="space-y-6">
        {/* system message */}
        <div className="text-center text-xs text-gray-400 dark:text-gray-500">
          This is a static mockup — messages here are sample content.
        </div>

        {/* assistant message */}
        <article className="flex items-start gap-3">
          <div className="flex-shrink-0">
            <div className="h-10 w-10 rounded-full bg-indigo-600 text-white flex items-center justify-center font-semibold">
              A
            </div>
          </div>

          <div className="flex-1">
            <div className="flex items-baseline gap-3">
              <h4 className="text-sm font-medium">Assistant</h4>
              <time className="text-xs text-gray-400">Today • 10:42</time>
            </div>

            <div className="mt-2 bg-gray-100 dark:bg-gray-900 rounded-lg px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
              Welcome to Radium — a chatroom built for AI workflows and tools.
              Right now this is a static UI so you can preview layout, spacing
              and components. Tool integrations will come next.
            </div>
          </div>
        </article>

        {/* user message */}
        <article className="flex items-start gap-3 justify-end">
          <div className="order-2 flex-shrink-0">
            <div className="h-10 w-10 rounded-full bg-gray-300 text-gray-700 flex items-center justify-center font-semibold">
              Y
            </div>
          </div>

          <div className="order-1 text-right">
            <div className="text-sm font-medium text-gray-600 dark:text-gray-300">
              You
            </div>
            <div className="mt-2 inline-block bg-indigo-600 text-white rounded-lg px-4 py-3 text-sm">
              Excited to try the tool integrations and model playground!
            </div>
            <div className="text-xs text-gray-400 mt-1">Today • 10:45</div>
          </div>
        </article>

        {/* long assistant reply (example of code/snippet block) */}
        <article className="flex items-start gap-3">
          <div className="flex-shrink-0">
            <div className="h-10 w-10 rounded-full bg-indigo-600 text-white flex items-center justify-center font-semibold">
              A
            </div>
          </div>

          <div className="flex-1">
            <div className="flex items-baseline gap-3">
              <h4 className="text-sm font-medium">Assistant</h4>
              <time className="text-xs text-gray-400">Today • 10:50</time>
            </div>

            <div className="mt-2 space-y-3">
              <p className="text-sm bg-gray-100 dark:bg-gray-900 rounded-lg px-4 py-3">
                When integrating tools into Radium we'll provide:
              </p>

              <ul className="text-sm list-disc list-inside text-gray-700 dark:text-gray-300">
                <li>Pluggable tool panels (right rail)</li>
                <li>Message-aware tool invocations (slash commands)</li>
                <li>Persistent chat rooms and workspaces</li>
              </ul>

              <div className="rounded-md bg-black/5 dark:bg-white/5 p-3 font-mono text-sm overflow-auto">
                {/* Static code-like block */}
                <pre className="whitespace-pre-wrap text-sm">
                  {`// Example: run a model (mock)
> /model play --name=gpt-radium --temp=0.2
[assistant] Running model (mock): gpt-radium — temperature 0.2`}
                </pre>
              </div>
            </div>
          </div>
        </article>

        {/* placeholder for attachments / tool preview */}
        <div className="rounded-md border border-dashed border-gray-200 dark:border-gray-800 p-4 text-sm text-gray-500 dark:text-gray-400">
          Room tools preview — the right rail in the layout will show available
          tools (model playground, file uploader, snippets). All features are
          disabled in this static build.
        </div>
      </section>

      {/* composer (static, disabled) */}
      <footer className="mt-8">
        <div className="sticky bottom-0 bg-transparent py-4">
          <div className="flex items-center gap-3 max-w-3xl mx-auto">
            <input
              aria-label="Message"
              placeholder="Write a message or /use a tool (static)"
              className="flex-1 rounded-md border border-gray-200 dark:border-gray-800 px-4 py-2 text-sm bg-white/30 dark:bg-black/30 focus:outline-none"
              disabled
            />
            <button
              className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm"
              disabled
            >
              Send
            </button>
          </div>

          <div className="max-w-3xl mx-auto text-xs text-gray-400 mt-2">
            Tip: Use <span className="font-semibold">/</span> to access slash
            commands (coming soon).
          </div>
        </div>
      </footer>
    </div>
  );
}
