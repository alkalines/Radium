"use client";

export default function Sidebar() {
  return (
    <aside className="w-64 bg-[#0f0f10] border-r border-[#1f1f1f] flex flex-col">
      <div className="p-4 flex-1 overflow-auto">
        <button className="w-full bg-[#1b1b1b] hover:bg-[#262626] text-sm py-2 rounded flex items-center gap-2 px-3">
          + New chat
        </button>

        <nav className="mt-4 space-y-2">
          <div className="text-xs text-gray-400 px-1">Recents</div>
          <div className="mt-2">
            <a className="block px-2 py-2 rounded hover:bg-[#1a1a1a]">
              Some of the chats here
            </a>
          </div>
        </nav>
      </div>
      <div className="p-4 border-t border-[#1f1f1f] mt-auto animate-fadeInUp">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#2b2b2b] flex items-center justify-center text-sm">
            AR
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">User name</div>
            <div className="text-xs text-gray-400">Admin</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
