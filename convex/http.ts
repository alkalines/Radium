import { httpRouter } from "convex/server";
import { HTTP_Request_Chat_Completion } from "./chat_completion";

const http = httpRouter();

/**
 * OpenAI Endpoint
 */

http.route({
  method: "POST",
  path: "/api/openai/v1/chat/completions",
  handler: HTTP_Request_Chat_Completion,
});

export default http