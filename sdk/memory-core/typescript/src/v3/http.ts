/** Strict HTTP transport used exclusively by v3 SDK clients. */

import { Agent } from "undici";
import { ParamError, TDAMError, TDAMResponseError, TDAMTransportError } from "../errors.js";
import type { HttpTransportOptions } from "../http.js";
import type { ApiResponseEnvelope } from "../types.js";

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiResponseEnvelope(value: unknown): value is ApiResponseEnvelope<unknown> {
  return isUnknownRecord(value)
    && typeof value.code === "number"
    && typeof value.message === "string"
    && typeof value.request_id === "string";
}

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
          );
        }
        throw new TDAMResponseError(
          `HTTP ${response.status} returned a non-JSON response`,
          headerRequestId,
          { cause: err },
        );
      }

      if (!isApiResponseEnvelope(parsed)) {
        throw new TDAMResponseError("API response must be an envelope with a numeric code", headerRequestId);
      }
      const envelope = parsed;

      const businessCode = envelope.code;
      if (!response.ok || businessCode !== 0) {
        const code = businessCode && businessCode !== 0 ? businessCode : response.status;
        const details =
          isUnknownRecord(envelope.data)
            ? envelope.data
            : undefined;
        throw new TDAMError(
          code,
          envelope.message || `HTTP ${response.status}`,
          headerRequestId || envelope.request_id || "",
          details,
        );
      }

      const result = envelope.data ?? {};
      if (!isUnknownRecord(result)) {
        throw new TDAMResponseError("API response data must be a JSON object", headerRequestId);
      }
      const traceId = response.headers.get("x-trace-id");
      const data = traceId ? { ...result, trace_id: traceId } : result;
      // Endpoint-specific public clients validate their success payloads. The
      // generic transport can only prove the shared object envelope here.
      return data as T & { trace_id?: string };
    } catch (err) {
      if (err instanceof TDAMError) throw err;
      const timedOut = controller.signal.aborted;
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
