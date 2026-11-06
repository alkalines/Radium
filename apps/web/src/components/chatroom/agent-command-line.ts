/** Split an executable and argv without invoking a shell or expanding variables/operators. */
export function parseAgentCommandLine(input: string): string[] {
  const args: string[] = [];
  let value = "";
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (quote === "'") {
      if (character === "'") quote = null;
      else value += character;
      continue;
    }
    if (character === "\\") {
      const next = input[++index];
      if (next === undefined) throw new Error("The command line ends with an unfinished escape.");
      if (next === "\n") continue;
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) value += "\\";
      value += next;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) args.push(value);
      value = "";
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) throw new Error("The command line has an unbalanced quote.");
  if (started) args.push(value);
  return args;
}

/** Quote stored argv so opening and saving a definition preserves every argument. */
export function formatAgentCommandLine(argv: readonly string[]): string {
  return argv
    .map((value) =>
      /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}
