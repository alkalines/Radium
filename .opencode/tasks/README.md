# ChatSDK Migration Tasks

This directory contains detailed task specifications for migrating the Radium chatroom interface to be similar to the ChatSDK (Vercel AI Chatbot).

## Overview

**Approach:** Preserve existing Radium structure, updating existing components in `src/components/ai-elements/` and `src/components/chatroom/`

**Reference Codebase:** `chatsdk/` (cloned from https://github.com/vercel/ai-chatbot.git)

**Artifacts/Canvas:** Skipped for now (can be added later as a separate initiative)

---

## Task Summary

### Phase 1: Quick Wins (Foundation)
These tasks have no dependencies and can be worked on in parallel.

| Task | File | Description | Complexity |
|------|------|-------------|------------|
| [1.1](./1.1-stop-generation-button.md) | Stop Generation Button | Allow users to stop AI responses mid-stream | Low |
| [1.2](./1.2-thinking-animation.md) | Thinking Animation | Animated "Thinking..." indicator with bouncing dots | Low |
| [1.3](./1.3-greeting-component.md) | Greeting Component | Welcome message for new/empty conversations | Low |

### Phase 2: Message Rendering Enhancements
These tasks should be completed after Phase 1.

| Task | File | Description | Complexity |
|------|------|-------------|------------|
| [2.1](./2.1-tool-invocation-rendering.md) | Tool Invocation Rendering | Display tool calls (weather, documents, etc.) in chat | Medium |
| [2.2](./2.2-file-attachments-display.md) | File Attachments Display | Show uploaded files/images in user messages | Medium |
| [2.3](./2.3-message-actions-copy.md) | Message Actions (Copy) | Add copy-to-clipboard action for messages | Low |

### Phase 3: Interactive Features
These tasks should be completed after Phase 2.

| Task | File | Description | Complexity |
|------|------|-------------|------------|
| [3.1](./3.1-suggested-actions.md) | Suggested Actions | Show prompt suggestions when chat is empty | Medium |
| [3.2](./3.2-message-edit-functionality.md) | Message Edit Functionality | Allow users to edit messages and regenerate | High |
| [3.3](./3.3-regenerate-response.md) | Regenerate Response | Allow users to regenerate the last AI response | Medium |

---

## Execution Order

```
Phase 1 (Can run in parallel):
├── Task 1.1: Stop Generation Button
├── Task 1.2: Thinking Animation  
└── Task 1.3: Greeting Component

Phase 2 (Sequential after Phase 1):
├── Task 2.1: Tool Invocation Rendering
├── Task 2.2: File Attachments Display
└── Task 2.3: Message Actions (Copy)

Phase 3 (Sequential after Phase 2):
├── Task 3.1: Suggested Actions (depends on 1.3)
├── Task 3.2: Message Edit Functionality (depends on 2.3)
└── Task 3.3: Regenerate Response (depends on 2.3)
```

---

## Key Files Reference

### Radium (Current Codebase)
- `src/app/chat/[chatID]/page.tsx` - Main chat page
- `src/components/chatroom/chat/PromptInput.tsx` - Chat input component
- `src/components/ai-elements/` - AI-related UI components
  - `message.tsx` - Message rendering components
  - `prompt-input.tsx` - Prompt input components
  - `reasoning.tsx` - Reasoning/thinking display
  - `tool.tsx` - Tool invocation display
  - `conversation.tsx` - Conversation container

### ChatSDK (Reference)
- `chatsdk/components/chat.tsx` - Main chat component
- `chatsdk/components/message.tsx` - Message rendering
- `chatsdk/components/multimodal-input.tsx` - Input with attachments
- `chatsdk/components/messages.tsx` - Messages container
- `chatsdk/components/greeting.tsx` - Greeting component
- `chatsdk/components/suggested-actions.tsx` - Suggested prompts

---

## Agent Instructions

When working on a task:

1. **Read the task file thoroughly** before starting
2. **Check the "Current State" section** to understand what exists
3. **Follow the "Implementation Details"** step by step
4. **Reference the ChatSDK files** mentioned in the task
5. **Check off items** in the "Completion Checklist" as you complete them
6. **Validate with Chrome DevTools MCP** (see Validation Requirements below)
7. **Write a task report** at `.opencode/tasks-reports/[task-number].md`

---

## Validation Requirements

**CRITICAL:** Every task MUST be validated using Chrome DevTools MCP tools before completion. Use bun as the package manager and runner of this project.

### Important Rules:
- **DO NOT** start Next.js dev server (`bun run dev`) - it is already running
- **DO NOT** start Convex dev server (`npx convex dev`) - it is already running
- If you need logs from either server, **ASK THE USER** to provide them

### Validation Tools to Use:
- `chrome-devtools_navigate_page` - Navigate to the chat page
- `chrome-devtools_take_snapshot` - Capture UI state for verification
- `chrome-devtools_click` - Test button interactions
- `chrome-devtools_hover` - Test hover states
- `chrome-devtools_fill` - Test form inputs
- `chrome-devtools_list_console_messages` - Check for JavaScript errors
- `chrome-devtools_take_screenshot` - Capture visual evidence if needed

### Validation Checklist:
- [ ] Page loads without errors
- [ ] No JavaScript console errors
- [ ] UI elements render correctly
- [ ] Interactive features work as expected
- [ ] No unexpected behaviors

---

## Task Reports

After completing (or attempting) each task, you MUST write a report at:

**`.opencode/tasks-reports/[task-number].md`**

Example: Task 1.1 → `.opencode/tasks-reports/1.1.md`

### Report Template:
```markdown
# Task [Number] Report: [Task Name]

## Status
- [ ] Completed
- [ ] Partially Completed
- [ ] Blocked

## Summary
Brief description of what was accomplished.

## Changes Made

### Files Modified
- `path/to/file.tsx` - Description of changes

### Files Created
- `path/to/new-file.tsx` - Description

## Deviations from Plan
Any changes from the original task specification.

## Issues Encountered
Problems faced and how they were resolved.

## Validation Results

### Console Messages
Any errors or warnings from the browser console.

### UI Behavior
Description of how the feature behaves.

### Screenshots/Snapshots
References to any captured screenshots.

## Recommendations
Suggestions for future improvements or follow-up tasks.
```

---

## Notes

- The `chatsdk/` folder has TypeScript errors because it's a reference codebase cloned from GitHub and lacks its own dependencies. These errors can be ignored - only use it for reference.
- Radium uses Convex for backend; ChatSDK uses Drizzle/Postgres. Focus on frontend changes only.
- Both use Vercel AI SDK v5 with the `useChat` hook.
- Radium already has many ai-elements components - reuse them when possible.
