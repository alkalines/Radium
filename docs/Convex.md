# Convex backend

Convex owns durable state, authorization, and coordination for Gateway and
Chatroom. Registered functions are in `packages/backend/convex/`; reusable
runtime-neutral policy lives in `packages/backend/src/`.

- [Authentication and function builders](Convex/Authentication.md)
- [Workspace ownership and migration](Radium_Gateway/Ownership.md)
- [Reuse research](research/Convex_Reuse.md)

The Agent Runner remains the planned external execution boundary. Convex
functions do not provide agent filesystem or shell execution.
