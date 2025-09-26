import React from "react";

export const metadata = {
  title: "Radium — Chat",
};

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="h-screen bg-[#141414] text-gray-100">{children}</div>;
}
