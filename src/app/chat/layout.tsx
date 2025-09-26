import Sidebar from "@/app/chat/components/Sidebar";
import React from "react";

export const metadata = {
  title: "Radium — Chat",
};

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen bg-[#141414] text-gray-100">
      <div className="flex h-full">
        <Sidebar />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
