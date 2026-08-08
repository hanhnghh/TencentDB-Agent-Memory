function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new TypeError("expected a string request body");
  }

  const parsed: unknown = JSON.parse(init.body);
  if (!isJsonObject(parsed)) {
    throw new TypeError("expected a JSON object request body");
  }

  return parsed;
}
