import { httpRouter } from "convex/server";
import { HTTP_Request_Chat_Completion } from "./chat_completion";
import { HTTP_Request_OpenAI_Models } from "./models";
import { authComponent, createAuth } from "./auth";
import { AISDK_POST_Chat } from "./aisdk.chat";

const http = httpRouter();

/**
 * OpenAI Endpoint
 */

http.route({
  method: "POST",
  path: "/api/openai/v1/chat/completions",
  handler: HTTP_Request_Chat_Completion,
});

http.route({
  method: "GET",
  path: "/api/openai/v1/models",
  handler: HTTP_Request_OpenAI_Models,
});

/**
 * Better Auth
*/
authComponent.registerRoutes(http, createAuth);

/**
 * AISDK
 */

http.route({
  method: "POST",
  path: "/api/aisdk/chat",
  handler: AISDK_POST_Chat,
});

export default http