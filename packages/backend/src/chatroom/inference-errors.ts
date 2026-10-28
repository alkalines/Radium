import type { GatewayErrorPayload } from "../routing/failures";

/** Explain HTTP failures without guessing a provider's plan, balance, or reset deadline. */
export function formatInferenceError(details: GatewayErrorPayload): string {
  let fallback: string;
  let action: string;
  switch (details.status) {
    case 429:
      fallback = "The provider's rate limit or usage quota was reached.";
      action = "Try again later or choose another provider/account.";
      break;
    case 401:
      fallback = "The provider could not authenticate the configured credentials.";
      action = "Check or reconnect the provider credentials, or choose another provider/account.";
      break;
    case 402:
      fallback = "The provider rejected the request for a billing or balance reason.";
      action =
        "Check the upstream account's billing or balance, or choose another provider/account.";
      break;
    case 403:
      fallback = "The provider denied access to this request.";
      action =
        "Check the account's permissions and model access, or choose another provider/account.";
      break;
    case 404:
      fallback = "The provider could not find the requested model or endpoint.";
      action = "Check the model configuration or choose another provider.";
      break;
    default:
      if (details.status >= 500) {
        fallback = "The provider or its connection could not complete the inference request.";
        action = "Try again later or choose another provider.";
      } else {
        fallback = "The provider rejected the inference request.";
        action = "Check the request settings and the provider's requirements.";
      }
  }
  const upstream = details.message.trim();
  const code =
    String(details.code) === String(details.status)
      ? `HTTP ${details.status}`
      : `${details.code}, HTTP ${details.status}`;
  return `${upstream || fallback} ${action} (${code})`;
}
