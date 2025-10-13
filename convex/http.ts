import { httpRouter } from "convex/server";
import { CreateCompletion } from "./chat_completion";

const http = httpRouter();

/**
 * OpenAI Endpoint
 */

http.route({
  method: 'POST',
  path: '/api/openai/v1/chat/completions',
  handler: CreateCompletion,
});

export default http