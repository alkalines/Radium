import type {
  AcpElicitationField,
  AcpElicitationValue,
  AcpInteractionRequest,
} from "backend/src/acp/contract";

export type FormRequest = Extract<AcpInteractionRequest, { kind: "elicitation"; mode: "form" }>;
export type FormValues = Record<string, string | string[] | undefined>;

/**
 * A URL-mode link as the reader checks it, read from the parsed `URL` rather than the raw text:
 * `host` is where the link really goes, `userinfo` (which can pose as a host) stands apart.
 */
export type AcpLink = {
  canOpen: boolean;
  scheme: string;
  userinfo: string;
  host: string;
  hostname: string;
  rest: string;
  punycode: boolean;
};

export { acpLink, choicesFor, initialValues, formContent, formatError };

/** `undefined` when the agent's URL does not parse. */
function acpLink(raw: string): AcpLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return {
    canOpen: url.protocol === "https:" || url.protocol === "http:",
    scheme: `${url.protocol}//`,
    userinfo: url.password ? `${url.username}:${url.password}` : url.username,
    host: url.host,
    hostname: url.hostname,
    rest: `${url.pathname}${url.search}${url.hash}`,
    punycode: url.hostname.split(".").some((label) => label.startsWith("xn--")),
  };
}

function choicesFor(field: AcpElicitationField) {
  if (field.type === "boolean")
    return [
      { value: "true", title: "Yes" },
      { value: "false", title: "No" },
    ];
  return field.type === "string" || field.type === "array" ? (field.choices ?? []) : [];
}

function initialValues(request: FormRequest): FormValues {
  return Object.fromEntries(
    request.fields.map((field, index) => [
      `f${index}`,
      field.default === undefined
        ? undefined
        : Array.isArray(field.default)
          ? field.default
          : String(field.default),
    ]),
  );
}

/** Convert only answered fields; an optional skipped property is absent, not an empty scalar. */
function formContent(request: FormRequest, values: FormValues): AcpElicitationValue[] {
  return request.fields.flatMap<AcpElicitationValue>((field, index) => {
    const value = values[`f${index}`];
    if (value === undefined || value === "") return [];
    if (field.type === "array")
      return [{ name: field.name, value: Array.isArray(value) ? value : [value] }];
    const scalar = Array.isArray(value) ? (value[0] ?? "") : value;
    return [
      {
        name: field.name,
        value:
          field.type === "boolean"
            ? scalar === "true"
            : field.type === "number" || field.type === "integer"
              ? Number(scalar)
              : scalar,
      },
    ];
  });
}

function formatError(request: FormRequest, content: AcpElicitationValue[]) {
  for (const entry of content) {
    const field = request.fields.find((candidate) => candidate.name === entry.name);
    if (field?.type !== "string" || typeof entry.value !== "string" || !field.format) continue;
    const value = entry.value;
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return `${field.title ?? field.name}: enter a valid email address.`;
    if (field.format === "uri") {
      try {
        new URL(value);
      } catch {
        return `${field.title ?? field.name}: enter a full URL.`;
      }
    }
    if (
      field.format === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      return `${field.title ?? field.name}: enter a valid date (YYYY-MM-DD).`;
  }
  return null;
}
