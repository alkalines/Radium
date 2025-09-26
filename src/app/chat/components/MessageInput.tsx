"use client";

import { useEffect, useRef, useState } from "react";

export default function MessageInput({
  onSend,
}: {
  onSend?: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  }

  useEffect(() => {
    resizeTextarea();
  }, [value]);

  function handleSend() {
    // ignore messages that are only whitespace
    if (value.replace(/\s/g, "") === "") return;
    onSend?.(value);
    setValue("");
  }

  return (
    <div className="mt-6">
      <div className="bg-[#222] rounded-lg p-3 flex flex-col gap-3 animate-fadeInUp">
        {/* Top: textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          className="w-full bg-transparent outline-none text-sm placeholder-gray-400 resize-none max-h-[400px] whitespace-pre-wrap"
          placeholder="How can I help you today? (Shift+Enter for newline)"
          aria-label="Message input"
          rows={1}
        />

        {/* Bottom row: left group and right group */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button className="w-8 h-8 rounded bg-[#2a2a2a] hover:bg-[#323232] transition text-gray-200">
              +
            </button>
            <button className="w-8 h-8 rounded bg-[#2a2a2a] hover:bg-[#323232] transition text-gray-200">
              ≡
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-xs text-gray-400 hidden sm:block">
              Model Name Here ▾
            </div>
            <button
              onClick={handleSend}
              aria-label="Send message"
              className="w-8 h-8 rounded bg-amber-700 text-white shadow hover:brightness-105 transition flex items-center justify-center"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
