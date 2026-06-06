# AGENTS.md - Radium AI Gateway

This document provides guidelines for AI coding agents working in this repository.

## Project Overview

Radium is a **self-hosted OpenAI-compatible AI Gateway** and **AI Chat Interface** for personal use. It routes LLM requests through various providers and includes a built-in chat UI powered by the Vercel AI SDK.

**Key Features:**
- OpenAI-compatible API endpoints (`/api/openai/v1/chat/completions`)
- Built-in AI chat interface with streaming support
- Multi-provider routing via OpenRouter
- API key management and usage tracking

**Tech Stack:**
- **Frontend:** Next.js 16 (App Router), React 19, Tailwind CSS 4.x, Radix UI, shadcn/ui
- **Backend:** Convex (serverless backend with real-time sync)
- **AI Integration:** Vercel AI SDK v5, OpenRouter
- **Auth:** Better Auth

## Build, Lint, and Test Commands

### Package Manager
Use **Bun** (primary) or npm as fallback.

### Commands
```bash
# Development
bun run dev          # Start Next.js dev server (uses Turbopack)
npx convex dev       # Start Convex backend dev server (run in separate terminal)

# Build & Production
bun run build        # Production build
bun run start        # Start production server

# Linting
bun run lint         # Run ESLint
```

### Testing
No test framework is currently configured. When testing:
1. Use browser automation tools (Chrome DevTools MCP) to test UI changes
2. Test API endpoints manually via curl or API clients
3. Verify Convex functions through the Convex dashboard

**Important:** When validating the chat interface or any UI changes, prefer using the `chrome-devtools` MCP tools (`chrome-devtools_navigate_page`, `chrome-devtools_take_snapshot`, `chrome-devtools_click`, etc.) to interact with and verify the interface in a real browser.

## Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── (gateway)/          # Gateway route group
│   ├── api/                # API routes (Next.js)
│   │   └── openai/v1/      # OpenAI-compatible endpoints
│   └── chat/               # Chat pages
├── components/
│   ├── ai-elements/        # AI-specific UI components
│   ├── chatroom/           # Chat interface
│   ├── providers/          # React context providers
│   └── ui/                 # shadcn/ui base components
├── lib/                    # Utilities and contexts
├── types/                  # TypeScript definitions
└── utils/
    ├── providers/          # AI provider implementations
    ├── translators/        # API translation layers
    └── types/              # Zod schemas and types

convex/                     # Convex backend
├── _generated/             # Auto-generated (do not edit)
├── http/                   # HTTP action handlers
├── schema.ts               # Database schema
└── *.ts                    # Backend functions
```

## Code Style Guidelines

### Import Order
1. External libraries (React, third-party packages)
2. Internal imports using `@/` path alias
3. Relative imports
4. CSS imports last

```typescript
// External
import { NextRequest } from "next/server";
import { z } from "zod";

// Internal (@/ alias)
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// Relative
import { api } from "../_generated/api";
```

### Naming Conventions

| Category | Convention | Example |
|----------|------------|---------|
| Files (components) | kebab-case | `button.tsx`, `auth-client.ts` |
| Files (utils) | snake_case or camelCase | `ai_balancer.ts` |
| React Components | PascalCase | `MessageContent`, `ConvexClientProvider` |
| Functions | camelCase | `cn()`, `getKeyInfo()` |
| HTTP Handlers | PascalCase with prefix | `HTTP_Request_Chat_Completion` |
| Types/Interfaces | PascalCase | `AIProviderConfig`, `MessageProps` |
| Zod schemas | PascalCase | `ChatCompletions_RequestBody` |
| Constants | camelCase or PascalCase | `buttonVariants` |

### TypeScript Patterns

- **Zod for runtime validation:** Use `z.object()` for API request/response schemas
- **Convex validators:** Use `v.object()` for Convex schema definitions
- **`any` is allowed:** ESLint rule is disabled, but prefer typed alternatives
- **Component props:** Extend HTML element props with `ComponentProps<"element">`

```typescript
// Zod schema with type inference
export const ChatCompletions_RequestBody = z.object({
  model: z.string(),
  messages: z.array(MessageSchema),
  stream: z.boolean().optional(),
});
export type ChatCompletions_RequestBody_Type = z.infer<typeof ChatCompletions_RequestBody>;

// Component props pattern
type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};
```

### Error Handling

```typescript
// API routes - use try-catch with Zod validation
try {
  const reqData = ChatCompletions_RequestBody.parse(await req.json());
  // ... handle request
} catch (e: any) {
  if (e instanceof z.ZodError) {
    return Response.json(e.issues, { status: 400 });
  }
  console.log(e);
  return Response.json({ error: e.message }, { status: 500 });
}

// Early return for auth validation
const authBearer = req.headers.get("Authorization")?.replace("Bearer ", "");
if (!authBearer || authBearer === "")
  return Response.json(
    { error: { message: "The Authorization field is empty!", code: 401 } },
    { status: 401 }
  );
```

### React Component Patterns

- Use **functional components** with destructured props
- Use **`cn()` utility** for conditional Tailwind class merging
- Use **CVA (class-variance-authority)** for component variants
- Add **`"use client"` directive** for client components
- Use **`data-slot` attribute** for component identification

```typescript
function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
```

### Convex Patterns

- Define schemas in `convex/schema.ts` using Convex validators (`v.object()`, etc.)
- Use `httpAction()` for HTTP endpoints in `convex/http/`
- Access generated API via `import { api, internal } from "./_generated/api"`
- Use `ctx.runQuery()`, `ctx.runMutation()`, `ctx.runAction()` for cross-function calls

## ESLint Configuration

```javascript
rules: {
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': 'warn',
  '@typescript-eslint/no-empty-object-type': 'warn',
  'prefer-const': 'warn',
  '@next/next/no-html-link-for-pages': 'error'
}
```

## Environment Variables

Copy `.env.example` to `.env.local` and configure:
- `NEXT_PUBLIC_CONVEX_URL` - Convex deployment URL
- `NEXT_PUBLIC_CONVEX_SITE_URL` - Convex site URL for HTTP actions
- Provider API keys as needed

## Documentation Tools

When you need library documentation:
1. Use Context7 MCP tools (`context7_resolve-library-id`, `context7_query-docs`)
2. Use `next-devtools_nextjs_docs` for Next.js-specific documentation
3. Reference existing code patterns in the codebase

## Key Dependencies

- `next@16.x` - React framework with App Router
- `convex@1.x` - Backend platform
- `ai@5.x` - Vercel AI SDK
- `better-auth@1.x` - Authentication
- `@openrouter/ai-sdk-provider` - OpenRouter AI provider
- `zod` - Runtime validation
- `class-variance-authority` - Component variants

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`bunx convex ai-files install`.

<!-- convex-ai-end -->
