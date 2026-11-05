import { ConvexError } from "convex/values";

/** Reveal only the actionable, intentionally public Worker-key revocation error. */
export function gatewayAuthorizationMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    let data: unknown = error.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return "The Authorization is invalid!";
      }
    }
    if (
      data &&
      typeof data === "object" &&
      "code" in data &&
      data.code === "GATEWAY_KEY_DELETED" &&
      "message" in data &&
      typeof data.message === "string"
    )
      return data.message;
  }
  return "The Authorization is invalid!";
}
