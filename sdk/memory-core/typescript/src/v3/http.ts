/** Strict HTTP transport used exclusively by v3 SDK clients. */

import { Agent } from "undici";
import {
  ParamError,
  TDAMError,
  TDAMResponseError,
  TDAMTransportError,
  type TDAMFailureKind,
} from "../errors.js";
import type { HttpTransportOptions } from "../http.js";

export class V3HttpTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly dispatcher?: Agent;

  constructor(opts: HttpTransportOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(opts.endpoint);
    } catch {
      throw new ParamError("endpoint must be a valid HTTP(S) URL");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new ParamError("endpoint must be a valid HTTP(S) URL");
    }
    if (!opts.apiKey?.trim()) throw new ParamError("apiKey must be provided");
    if (!opts.serviceId?.trim()) throw new ParamError("serviceId must be provided");
    const timeout = opts.timeout ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new ParamError("timeout must be a positive number");
    }

    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.timeout = timeout;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "x-tdai-service-id": opts.serviceId,
      "Content-Type": "application/json",
    };
    if (opts.userKey) this.headers["x-tdai-user-key"] = opts.userKey;
    if (opts.rejectUnauthorized === false) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  async post<T = unknown>(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<T & { trace_id?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const fetchOptions: RequestInit & { dispatcher?: Agent } = {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      if (this.dispatcher) fetchOptions.dispatcher = this.dispatcher;
      const response = await fetch(`${this.endpoint}${path}`, fetchOptions);
      const responseText = await response.text().catch(() => "");
      const headerRequestId =
        response.headers.get("x-qcloud-transaction-id") ??
        response.headers.get("x-trace-id") ??
        "";

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch (err) {
        if (!response.ok) {
          throw new TDAMError(
            response.status,
            `HTTP ${response.status} returned a non-JSON response`,
            headerRequestId,
            undefined,
            classifyFailure(response.status, response.status),
          );
        }
        throw new TDAMResponseError(
          `HTTP ${response.status} returned a non-JSON response`,
          headerRequestId,
          { cause: err },
        );
      }

      if (!isRecord(parsed) || typeof parsed.code !== "number") {
        throw new TDAMResponseError("API response must be an envelope with a numeric code", headerRequestId);
      }
      const envelope = parsed;

      const businessCode = envelope.code;
      if (!response.ok || businessCode !== 0) {
        const code = businessCode && businessCode !== 0 ? businessCode : response.status;
        const details =
          isRecord(envelope.data) ? envelope.data : undefined;
        throw new TDAMError(
          code,
          readString(envelope.message) ?? `HTTP ${response.status}`,
          headerRequestId || readString(envelope.request_id) || "",
          details,
          classifyFailure(response.status, code),
        );
      }

      if (!isRecord(envelope.data)) {
        throw new TDAMResponseError(
          "API response data must be a JSON object",
          headerRequestId || readString(envelope.request_id) || "",
        );
      }
      const result = { ...envelope.data };
      const traceId = response.headers.get("x-trace-id");
      if (traceId) result.trace_id = traceId;
      // `post<T>` is the SDK's low-level generic seam. Public clients with
      // reliability-sensitive payloads validate this record before return.
      return result as T & { trace_id?: string };
    } catch (err) {
      if (err instanceof TDAMError) throw err;
      const timedOut = controller.signal.aborted
        || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
      throw new TDAMTransportError(
        timedOut ? "timeout" : "network",
        timedOut ? `Request timed out after ${this.timeout}ms` : "Network request failed",
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function classifyFailure(httpStatus: number, code: number): {
  kind: TDAMFailureKind;
  retryable: boolean;
  httpStatus: number;
} {
  const kind: TDAMFailureKind = httpStatus === 408
    ? "timeout"
    : httpStatus === 429 || code === 4291
      ? "rate_limit"
      : httpStatus === 409 || code === 40902
        ? "conflict"
        : httpStatus >= 500 || code >= 50000
          ? "server"
          : httpStatus >= 400 || (code >= 40000 && code < 50000)
            ? "client"
            : "envelope";
  return {
    kind,
    retryable: httpStatus === 408 || httpStatus === 429 || code === 4291 || httpStatus >= 500 || code >= 50000,
    httpStatus,
  };
}
