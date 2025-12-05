"use client";

import Image from "next/image";

export type RadiumLetter = "A" | "D" | "I" | "M" | "R" | "U";

interface LetterIconProps {
  letter?: RadiumLetter;
}

export function LetterIcon({ letter = "R" }: LetterIconProps) {
  return (
    <div
      className="relative inline-block align-middle pt-0.5 md:mr-3"
      style={{ opacity: 1, width: "auto", transform: "none" }}
    >
      <div style={{ opacity: 1 }}>
        <div className="w-8 inline-block" style={{ position: "relative" }}>
          <Image
            src={`/letters/${letter}.svg`}
            alt={`Radium letter ${letter}`}
            width={32}
            height={32}
            priority
          />
        </div>
      </div>
    </div>
  );
}
