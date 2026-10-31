import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { QUESTION_TOOL_ID, TODO_TOOL_ID } from "./tools";

/**
 * Session tools: harness primitives that act only on the conversation itself (no credentials,
 * Worker, or network). Each is a default-on built-in tool set of the same id
 * (`BUILTIN_TOOL_SETS` in `./tools`), so it can be switched off per workspace or chat. Their
 * shapes follow OpenCode's `question` and `todowrite` tools and ACP plan entries so a future ACP
 * agent's prompts and plans can render through the same UI.
 */

const questionOptionSchema = z.object({
  label: z.string().min(1).describe("Display text (1-5 words, concise)"),
  description: z.string().optional().describe("Explanation of the choice"),
});

const questionSchema = z.object({
  question: z.string().min(1).describe("Complete question"),
  header: z.string().min(1).describe("Very short label (max 30 chars)"),
  options: z.array(questionOptionSchema).max(10).describe("Available choices"),
  multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
});

const questionInputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(8).describe("Questions to ask"),
});

/** One question the model asks; the user also gets a free-form answer field. */
export type QuestionPrompt = z.infer<typeof questionSchema>;

/**
 * The browser's answer to a `question` call, one entry per question in call order. An empty
 * entry means the user left that question unanswered. A dismissed prompt is an `output-error`
 * whose text tells the model the user declined to answer.
 */
export type QuestionOutput = { answers: string[][] };

/** ACP plan entry statuses; the list renders above the Composer. */
export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

const todoItemSchema = z.object({
  content: z.string().min(1).describe("Brief description of the task"),
  status: z.enum(TODO_STATUSES).describe("pending, in_progress, or completed"),
});

const todoInputSchema = z.object({
  todos: z.array(todoItemSchema).max(50).describe("The complete updated todo list"),
});

export type TodoItem = z.infer<typeof todoItemSchema>;

/** The model-facing text for answered questions, matching OpenCode's wording. */
export function formatQuestionAnswers(questions: QuestionPrompt[], output: QuestionOutput) {
  const formatted = questions
    .map((question, index) => {
      const answer = output.answers[index];
      const value = answer && answer.length > 0 ? answer.join(", ") : "Unanswered";
      return `"${question.question}"="${value}"`;
    })
    .join(", ");
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

/** Short model-facing receipt for a todo update; the list itself already sits in the call input. */
export function summarizeTodos(todos: TodoItem[]) {
  if (todos.length === 0) return "Todos cleared";

  const completed = todos.filter((todo) => todo.status === "completed").length;
  const pending = todos.filter((todo) => todo.status === "pending").length;
  const active = todos.filter((todo) => todo.status === "in_progress");
  let summary = `Todos updated: ${completed}/${todos.length} completed`;
  if (active.length > 0) summary += `, ${active.length} in progress`;
  if (pending > 0) summary += `, ${pending} pending`;
  if (active.length > 0) {
    summary += `. In progress: ${active.map((todo) => JSON.stringify(todo.content)).join(", ")}`;
  }
  return summary;
}

/**
 * Builds the session tools among `enabledToolSets` (a chat's effective built-in set ids).
 * `question` has no `execute`: the stream ends at the call, the browser answers it with
 * `addToolOutput`, and the client continues the turn. `todo_write` executes immediately; the
 * browser reads the latest list from the call input.
 */
export function buildSessionTools(enabledToolSets: readonly string[]): ToolSet {
  const tools: ToolSet = {};

  if (enabledToolSets.includes(QUESTION_TOOL_ID)) {
    tools[QUESTION_TOOL_ID] = tool({
      description: `Ask the user questions during execution. Use it to gather preferences or requirements, clarify ambiguous instructions, get decisions on implementation choices, or offer choices about what direction to take.

Usage notes:
- A "Type your own answer" field is added automatically; don't include a separate option for free-form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
- Ask all related questions in one call; the user answers them one at a time`,
      inputSchema: questionInputSchema,
      outputSchema: z.object({ answers: z.array(z.array(z.string())) }),
      toModelOutput: ({ input, output }) => ({
        type: "text",
        value: formatQuestionAnswers(input.questions, output),
      }),
    });
  }

  if (enabledToolSets.includes(TODO_TOOL_ID)) {
    tools[TODO_TOOL_ID] = tool({
      description: `Create and update a todo list for the current session. The user sees it above the prompt as your working plan.

Use it proactively when a task has 3 or more distinct steps, or when the user gives several tasks or asks for a todo list. Skip it for a single simple task or a purely conversational request.

- Send the full list on every call; it replaces the previous one.
- Mark an item \`in_progress\` when you start it (one at a time) and \`completed\` as soon as it is actually done.
- Only call it when the list changes.`,
      inputSchema: todoInputSchema,
      execute: ({ todos }) => summarizeTodos(todos),
    });
  }

  return tools;
}
