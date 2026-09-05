/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai_gateway from "../ai_gateway.js";
import type * as aisdk from "../aisdk.js";
import type * as aisdk_schemas from "../aisdk_schemas.js";
import type * as auth from "../auth.js";
import type * as authors from "../authors.js";
import type * as chat_titles from "../chat_titles.js";
import type * as chatgpt_subscription from "../chatgpt_subscription.js";
import type * as chatroom from "../chatroom.js";
import type * as credits from "../credits.js";
import type * as exa from "../exa.js";
import type * as http from "../http.js";
import type * as http_chat_completion from "../http/chat_completion.js";
import type * as http_models from "../http/models.js";
import type * as key from "../key.js";
import type * as keys from "../keys.js";
import type * as logs from "../logs.js";
import type * as mcp from "../mcp.js";
import type * as models from "../models.js";
import type * as providers from "../providers.js";
import type * as secrets from "../secrets.js";
import type * as subscriptions from "../subscriptions.js";
import type * as telemetry from "../telemetry.js";
import type * as telemetry_integration from "../telemetry_integration.js";
import type * as telemetry_schemas from "../telemetry_schemas.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai_gateway: typeof ai_gateway;
  aisdk: typeof aisdk;
  aisdk_schemas: typeof aisdk_schemas;
  auth: typeof auth;
  authors: typeof authors;
  chat_titles: typeof chat_titles;
  chatgpt_subscription: typeof chatgpt_subscription;
  chatroom: typeof chatroom;
  credits: typeof credits;
  exa: typeof exa;
  http: typeof http;
  "http/chat_completion": typeof http_chat_completion;
  "http/models": typeof http_models;
  key: typeof key;
  keys: typeof keys;
  logs: typeof logs;
  mcp: typeof mcp;
  models: typeof models;
  providers: typeof providers;
  secrets: typeof secrets;
  subscriptions: typeof subscriptions;
  telemetry: typeof telemetry;
  telemetry_integration: typeof telemetry_integration;
  telemetry_schemas: typeof telemetry_schemas;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  secretStore: import("convex-secret-store/_generated/component.js").ComponentApi<"secretStore">;
};
