# AI Provider

## About

The AI Provider should be the area where we create an unique endpoint to route every piece of LLM chat through. It should have the same idea as OpenRouter and LiteLLM does where it tracks the API Key and pricing per token used. It also padronizes the use of different APIs like XAI, Anthropic and OpenAI have all different types. We will use as OpenRouter does with OpenAI Chat Completion API but soon will use Responses API because is a hell of a lot more efficient.

When OpenRouter and LiteLLM where created there wasn't much space for Vercel AI SDK which will be using to facilitate our life. Non-tool models may not even be used by us but is thing for a future.

## Tasks

- [ ] Create an Provider for the AI SDK to route ALL the traffic.
- [ ] Create an API Endpoint at `/api/openai/v1` to completion systems.
- [ ] Make the router between endpoint and sort systems has OpenRouter does.
- [ ] Integrate to Convex for credit usage and API Key security.

## How do we do it?

I canceled this fork, but now i wont! The core of this is **SSE** (Server Sent Events), they are similar to websocket but unidirectional and how OpenAI Compatible and any other API works. Biel was thinking on doing it with Spring and a webserver, but i really like TS and IntelliJ on Linux was kinda of a mess... And i just realized SSE aren't websockets.
