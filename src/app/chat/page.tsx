import ChatWindow from "@/app/chat/components/ChatWindow";
import Sidebar from "@/app/chat/components/Sidebar";

export default function Page() {
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 p-8">
        <div className="max-w-4xl mx-auto">
          <header className="text-center mb-8">
            <h1 className="text-5xl font-serif text-[#efe6de]">
              What's new, User?
            </h1>
          </header>
          <ChatWindow />
        </div>
      </main>
    </div>
  );
}
