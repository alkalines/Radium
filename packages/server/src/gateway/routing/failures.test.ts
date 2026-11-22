import { APICallError, StreamProviderError } from "ai";
import { expect, test } from "vitest";
import { gatewayErrorFromBody, gatewayErrorPayload, upstreamFailureFromError } from "./failures";

const failures = [
  {
    status: 429,
    code: "usage_limit_reached",
    type: "usage_limit_reached",
    message: "Subscription usage limit reached.",
  },
  {
    status: 401,
    code: "invalid_api_key",
    type: "authentication_error",
    message: "Invalid API key.",
  },
  {
    status: 402,
    code: "insufficient_balance",
    type: "payment_required",
    message: "Insufficient provider balance.",
  },
];

test.each(failures)("retains upstream HTTP $status and code $code independently", (details) => {
  const error = new APICallError({
    message: "Provider HTTP error",
    url: "https://upstream.invalid",
    requestBodyValues: {},
    statusCode: details.status,
    responseBody: JSON.stringify({ error: details }),
    responseHeaders: { "retry-after": "15", authorization: "must-not-be-returned" },
  });
  const failure = upstreamFailureFromError(error, false);
  expect(gatewayErrorPayload(failure, "provider")).toEqual({ ...details, provider: "provider" });
  expect(JSON.stringify(gatewayErrorPayload(failure))).not.toContain("must-not-be-returned");
});

test("typed SDK errors inside HTTP 200 streams retain their quota status", () => {
  const failure = upstreamFailureFromError(
    new StreamProviderError({
      message: "Quota exhausted",
      code: "insufficient_quota",
      type: "insufficient_quota",
      statusCode: 429,
    }),
    true,
  );
  expect(failure).toMatchObject({ status: 429, code: "insufficient_quota", outputStarted: true });
});

test("arbitrary in-band provider codes survive without a provider-specific status guess", () => {
  const failure = upstreamFailureFromError(
    {
      type: "response.failed",
      response: {
        error: { code: "provider_custom_failure", message: "Provider rejected inference" },
      },
    },
    false,
  );
  expect(gatewayErrorPayload(failure)).toEqual({
    status: 502,
    code: "provider_custom_failure",
    message: "Provider rejected inference",
  });
});

test("internal JSON and SSE errors preserve machine-readable details across the SDK bridge", () => {
  const details = { ...failures[2]!, provider: "provider" };
  const error = gatewayErrorFromBody({ error: details }, 502);
  expect(error?.details).toEqual(details);
  expect(gatewayErrorPayload(upstreamFailureFromError(error, true), details.provider)).toEqual(
    details,
  );
  expect(gatewayErrorFromBody({ choices: [] }, 502)).toBeUndefined();
});
