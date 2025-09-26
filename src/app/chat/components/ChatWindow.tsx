"use client";
import { useCallback } from "react";
import MessageInput from "./MessageInput";

export default function ChatWindow() {
  const handleSend = useCallback((text: string) => {
    // Placeholder: actual send logic will be implemented later.
    // For now we simply log to console so the UI is interactive.
    console.log("send:", text);
  }, []);

  return (
    <div className="rounded-xl p-6 animate-fadeInUp">
      {/* Intro header inside the window */}

      <MessageInput onSend={handleSend} />
    </div>
  );
}
