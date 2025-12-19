import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";
import { HTTP_Request_Chat_Completion } from "./http/chat_completion";
import { AISDK_GET_Chat_Stream, AISDK_POST_Chat } from "./http/aisdk.chat";
import { HTTP_Request_OpenAI_Models } from "./http/models";

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
  method: "GET",
  pathPrefix: "/api/aisdk/chat/stream/",
  handler: AISDK_GET_Chat_Stream,
});

http.route({
  method: "POST",
  path: "/api/aisdk/chat",
  handler: AISDK_POST_Chat,
});

export default http;
