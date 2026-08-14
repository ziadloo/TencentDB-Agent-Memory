/**
 * HTTP client — forwards MCP tool calls to the Hono knowledge API.
 *
 * Each MCP tool maps to a POST endpoint on the knowledge service.
 * The client sends the tool arguments as JSON body and returns the
 * ApiResponseEnvelope data field (or error).
 */

import { createLogger } from "../logger.js";

const log = createLogger("mcp-http");

export interface HttpClientOptions {
  baseUrl: string;
  /** Bearer token used by the backend gateway. */
  token?: string;
  /** Optional user key forwarded to MemoryCore metadata routes. */
  userKey?: string;
  /** Tenant/service identifier forwarded to both backends. */
  serviceId?: string;
  /** Optional second backend used by the remote MCP bridge. */
  coreBaseUrl?: string;
  /** Internal MemoryCore gateway credential, never supplied by the MCP client. */
  coreToken?: string;
}

export interface ApiResponse {
  code: number;
  message: string;
  data: unknown;
}

/**
 * Call a knowledge API endpoint.
 * @param endpoint Path without /v3 prefix (e.g. "/wiki/search", "/code-graph/search")
 * @param body Request body
 * @returns The ApiResponseEnvelope data field on success, or throws on error.
 */
export async function callApi(
  opts: HttpClientOptions,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const path = endpoint.startsWith("/v3/") ? endpoint : `/v3${endpoint}`;
  const url = `${opts.baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.userKey) headers["x-tdai-user-key"] = opts.userKey;
  if (opts.serviceId) headers["x-tdai-service-id"] = opts.serviceId;

  log.debug(`POST ${url}`);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`fetch failed for ${endpoint}: ${msg}`);
    throw err;
  }

  let json: ApiResponse;
  try {
    json = (await resp.json()) as ApiResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`JSON parse failed for ${endpoint} (status=${resp.status}): ${msg}`);
    throw new Error(`API error: ${resp.status} (invalid JSON)`);
  }

  if (resp.status >= 400 || json.code !== 0) {
    log.warn(`API error on ${endpoint}: status=${resp.status} code=${json.code} message="${json.message}"`);
    throw new Error(json.message || `API error: ${resp.status}`);
  }

  return json.data;
}
