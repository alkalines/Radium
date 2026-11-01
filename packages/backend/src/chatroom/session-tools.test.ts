import { expect, test } from "vitest";
import { buildSessionTools } from "./session-tools";
import {
  CODE_MODE_TOOL_SET_ID,
  QUESTION_TOOL_ID,
  TODO_TOOL_ID,
  enabledBuiltinToolSets,
  storedBuiltinToolSets,
} from "./tools";

const questions = [
  { question: "Which database?", header: "Database", options: [{ label: "SQLite" }] },
  { question: "Which regions?", header: "Regions", options: [], multiple: true },
];

test("question waits for the browser and reports every answer, including unanswered ones", async () => {
  const question = buildSessionTools([QUESTION_TOOL_ID])[QUESTION_TOOL_ID];

  // No server execute: the stream must stop at the call so the browser can answer it.
  expect(question?.execute).toBeUndefined();
  const modelOutput = await question?.toModelOutput?.({
    toolCallId: "call-1",
    input: { questions },
    output: { answers: [["SQLite"], []] },
  });
  expect(modelOutput).toEqual({
    type: "text",
    value:
      'User has answered your questions: "Which database?"="SQLite", "Which regions?"="Unanswered". You can now continue with the user\'s answers in mind.',
  });
});

test("todo_write replaces the list and summarizes progress for the model", () => {
  const todo = buildSessionTools([TODO_TOOL_ID])[TODO_TOOL_ID];
  const options = { toolCallId: "call-2", messages: [] } as never;
  const todos = [
    { content: "Map the code", status: "completed" },
    { content: "Write the tool", status: "in_progress" },
    { content: "Verify", status: "pending" },
  ];

  expect(todo?.execute?.({ todos }, options)).toBe(
    'Todos updated: 1/3 completed, 1 in progress, 1 pending. In progress: "Write the tool"',
  );
  expect(todo?.execute?.({ todos: [] }, options)).toBe("Todos cleared");
});

test("default-on sets stay on until a saved opt-out switches them off", () => {
  // Selections saved before the default-on sets existed have no opt-outs, so they get all of them.
  const legacy = enabledBuiltinToolSets({ builtinToolSets: ["web_search"] });
  expect(legacy).toEqual([QUESTION_TOOL_ID, TODO_TOOL_ID, "web_search", CODE_MODE_TOOL_SET_ID]);
  expect(Object.keys(buildSessionTools(legacy))).toEqual([QUESTION_TOOL_ID, TODO_TOOL_ID]);

  // Saving a list without `question` and Code Mode records them as switched off and survives the
  // round trip.
  const stored = storedBuiltinToolSets([TODO_TOOL_ID, "web_search"]);
  expect(stored).toEqual({
    builtinToolSets: ["web_search"],
    disabledBuiltinToolSets: [QUESTION_TOOL_ID, CODE_MODE_TOOL_SET_ID],
  });
  expect(enabledBuiltinToolSets(stored)).toEqual([TODO_TOOL_ID, "web_search"]);
  expect(Object.keys(buildSessionTools(enabledBuiltinToolSets(stored)))).toEqual([TODO_TOOL_ID]);
});
