/** Runtime validation shared by durable L0 ingestion receipt adapters. */

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireReceiptString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Malformed L0 ingestion receipt field: ${field}`);
  }
  return value;
}

export function parseReceiptStringArray(value: unknown, field: string): string[] {
  const serialized = requireReceiptString(value, field);
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`Malformed L0 ingestion receipt field: ${field}`);
  }
  return parsed;
}

export function validateAcceptedReceiptArrays(ids: string[], versions: string[]): void {
  if (ids.length !== versions.length) {
    throw new Error("Malformed L0 ingestion receipt: accepted arrays differ in length");
  }
}
