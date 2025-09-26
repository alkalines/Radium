import React from "react";

export const metadata = {
  title: "Radium — Chat",
  description: "Radium chatroom layout with sidebar and main area",
};

export default function ChatLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen flex bg-[var(--background)] text-[var(--foreground)]">
      {/* Sidebar */}
      <aside className="w-80 border-r border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-black/40 backdrop-blur-sm flex flex-col">
        <header className="px-4 py-5 flex items-center justify-between border-b border-gray-100 dark:border-gray-900">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-semibold">
              R
            </div>
            <div>
              <h1 className="text-sm font-semibold">Radium</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">AI Chatrooms</p>
            </div>
          </div>

          <button
            aria-label="New chat"
            className="text-sm px-3 py-1 rounded bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            + New
          </button>
        </header>

        {/* Search */}
        <div className="px-4 py-3">
          <div className="relative">
            <input
              type="search"
              placeholder="Search chats or tools..."
              className="w-full rounded-md border border-gray-200 dark:border-gray-800 bg-white/30 dark:bg-black/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              disabled
            />
            <div className="absolute inset-y-0 right-3 flex items-center text-gray-400 text-xs">
              ⌘K
            </div>
          </div>
        </div>

        {/* Chat list */}
        <nav className="px-2 py-3 overflow-y-auto flex-1">
          <ul className="space-y-2">
            {[
              "General",
              "Product Feedback",
              "Model Experiments",
              "Community",
              "Integrations",
            ].map((room) => (
              <li key={room}>
                <a
                  href="#"
                  className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors group"
                >
                  <span className="h-8 w-8 rounded-md bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-sm">
                    {room[0]}
                  </span>
                  <div className="flex-1">
                    <div className="text-sm font-medium">{room}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      A short room description
                    </div>
                  </div>
                  <div className="text-xs text-gray-400">• 2</div>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Sidebar footer */}
        <div className="px-4 py-4 border-t border-gray-100 dark:border-gray-900">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-gradient-to-br from-pink-500 to-yellow-400 flex items-center justify-center text-white font-semibold">
              AU
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium">Arthur</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Free plan</div>
            </div>
            <button className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-800">
              Manage
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col">
        {/* Top bar */}
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-900 bg-white/40 dark:bg-black/40 backdrop-blur-sm flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold">General</h2>
            <span className="text-sm text-gray-500 dark:text-gray-400">A place to test models and tools</span>
          </div>

          <div className="flex items-center gap-3">
            <button className="px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 text-sm">Members</button>
            <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm">Run Tools</button>
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 overflow-hidden flex">
          {/* Messages container */}
          <section className="flex-1 p-6 overflow-auto">
            <div className="max-w-3xl mx-auto">
              {/* Example message bubbles */}
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 rounded-full bg-indigo-500 text-white flex items-center justify-center font-semibold">A</div>
                  <div>
                    <div className="text-sm font-medium">Assistant</div>
                    <div className="mt-2 bg-gray-100 dark:bg-gray-900 rounded-lg px-4 py-3 text-sm">
                      Welcome to Radium — the chatroom for building with AI tools. This is a static mockup; integrations will be added later.
                    </div>
                    <div className="text-xs text-gray-400 mt-1">Today • 10:42</div>
                  </div>
                </div>

                <div className="flex items-start gap-3 justify-end">
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-600 dark:text-gray-300">You</div>
                    <div className="mt-2 inline-block bg-indigo-600 text-white rounded-lg px-4 py-3 text-sm">
                      Looking forward to exploring the tools!
                    </div>
                    <div className="text-xs text-gray-400 mt-1">Today • 10:45</div>
                  </div>
                  <div className="h-8 w-8 rounded-full bg-gray-300 text-gray-700 flex items-center justify-center font-semibold">Y</div>
                </div>

                {/* Placeholder for children (real chat UI will be injected here) */}
                <div>{children}</div>
              </div>
            </div>
          </section>

          {/* Right rail (tools / info) */}
          <aside className="w-80 border-l border-gray-100 dark:border-gray-900 p-4 hidden xl:block">
            <h3 className="text-sm font-semibold mb-2">Room tools</h3>
            <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
              <div className="p-3 rounded-md bg-gray-50 dark:bg-gray-900">Tool: Model Playground (coming soon)</div>
              <div className="p-3 rounded-md bg-gray-50 dark:bg-gray-900">Tool: File Uploader (coming soon)</div>
              <div className="p-3 rounded-md bg-gray-50 dark:bg-gray-900">Tool: Snippets</div>
            </div>
          </aside>
        </div>

        {/* Composer */}
        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-900 bg-white/50 dark:bg-black/50 backdrop-blur-sm">
          <div className="max-w-3xl mx-auto flex items-center gap-3">
            <input
              type="text"
              placeholder="Write a message or /use a tool (static)"
              className="flex-1 rounded-md border border-gray-200 dark:border-gray-800 px-4 py-2 text-sm bg-white/30 dark:bg-black/30 focus:outline-none"
              disabled
            />
            <button className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm">Send</button>
          </div>
        </div>
      </main>
    </div>
  );
}
