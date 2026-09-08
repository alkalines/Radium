# Authors Cleanup

Status: Not started. Independent; coordinate model/import edits with task 04.

## Entry Points

Under `packages/website/`: `convex/authors.ts`, `convex/models.ts`,
`convex/providers.ts`, `convex/schema.ts`, `src/utils/models_dev.ts`,
`src/app/chat/$chatId.tsx`, and `src/components/chat/chat-prompt-input.tsx`.

## Work

1. Search actual callers, generated API exposure, model imports, persisted references, and model-selector display. Initial inspection found no repository callers for standalone author queries, but active author-table consumers.
2. Remove only proven unused surfaces. Check whether public functions have external consumers before removal; document the evidence or ask if uncertain.
3. If simplifying the persisted author model is worthwhile, propose a separate migration with display/import requirements instead of deleting the table in this cleanup.
4. Document the resulting model catalog in `docs/Radium_Gateway/Models.md` and link it from the product overview.

## Acceptance

- Model import/upsert, hydrated model listing, and model-selector attribution keep working.
- References and generated bindings are verified with safe generation/checks; generated files are never manually edited.
- Package metadata `author` fields are not confused with this feature. No opportunistic data deletion.
