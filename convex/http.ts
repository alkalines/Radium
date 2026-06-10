import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { HTTP_Request_Chat_Completion } from "./http/chat_completion";
import { handleAISDKChat } from "./http/aisdk.chat";
import { HTTP_Request_OpenAI_Models } from "./http/models";

const http = httpRouter();

function aisdkCorsHeaders() {
  const origin = new URL(process.env.SITE_URL!).origin;

  return {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

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
  handler: httpAction((ctx, req) =>
    handleAISDKChat(ctx, req, aisdkCorsHeaders()),
  ),
});

http.route({
  method: "OPTIONS",
  path: "/api/aisdk/chat",
  handler: httpAction(async () =>
    new Response(null, {
      status: 204,
      headers: aisdkCorsHeaders(),
    }),
  ),
});

export default http;
