/**
 * Netlify API v1 client: the `netlify` secret, Link-header paging, rate limits, retries.
 *
 * - **Auth.** A `netlify` DuckDB secret carries a personal access token or OAuth
 *   token (sent as `Authorization: Bearer <token>`) and an optional `BASE_URL`
 *   (default https://api.netlify.com/api/v1; http:// only for a loopback fixture).
 *   Credentials are read from the secret on every call and never enter scan state.
 * - **Paging.** List endpoints take `page` + `per_page` and answer with
 *   `Link: <…?page=2&per_page=100>; rel="next"`. `netlifyGet` returns the next page
 *   NUMBER (never the URL, so a crafted Link header cannot redirect the token).
 * - **Rate limits.** Netlify answers with `X-RateLimit-Limit / -Remaining / -Reset`
 *   (reset = epoch seconds). A 429 waits for `Retry-After` or the reset (bounded);
 *   when the bucket is about to run dry the client pauses before the next call.
 *   5xx and network errors retry with exponential backoff.
 * - **Read-only.** Only GET is ever issued.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "netlify";
export const DEFAULT_BASE_URL = "https://api.netlify.com/api/v1";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a rate-limit reset. */
export const MAX_RATE_WAIT_MS = 65_000;
const USER_AGENT = `vgi-netlify-worker/${VERSION}`;

export class NetlifyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface NetlifyConfig {
  baseUrl: string;
  token: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new NetlifyError(
      `netlify secret: base_url '${raw}' is not a URL (expected e.g. https://api.netlify.com/api/v1)`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new NetlifyError(
      "netlify secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Build the client config from the `netlify` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): NetlifyConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new NetlifyError(
      "no netlify secret: run CREATE SECRET (TYPE netlify, TOKEN '<personal access token>') " +
        "(create one under User settings > Applications > Personal access tokens)",
    );
  }
  const token = str(s.token);
  if (!token) throw new NetlifyError("netlify secret: TOKEN is required (a personal access token or OAuth token)");
  return { baseUrl: normalizeBaseUrl(str(s.base_url) ?? DEFAULT_BASE_URL), token };
}

/** Build the request URL; undefined / empty query values are dropped. */
export function buildUrl(cfg: NetlifyConfig, path: string, query: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, v);
  const q = qs.toString();
  return `${cfg.baseUrl}${path}${q ? `?${q}` : ""}`;
}

/** Parse an RFC 8288 Link header into rel → URL. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]*)>\s*;(.*)/);
    if (!m) continue;
    const rel = m[2]?.match(/rel\s*=\s*"?([^";]+)"?/i)?.[1];
    if (rel && m[1] !== undefined) for (const r of rel.trim().split(/\s+/)) out[r.toLowerCase()] = m[1];
  }
  return out;
}

/** The page number of a Link header's rel="next" URL, or undefined when there is none. */
export function nextPageOf(header: string | null): number | undefined {
  const next = parseLinkHeader(header).next;
  if (!next) return undefined;
  try {
    const p = new URL(next, "http://x").searchParams.get("page");
    return p && /^\d+$/.test(p) ? Number(p) : undefined;
  } catch {
    return undefined;
  }
}

/** Last rate-limit reading per API origin (module-level: one worker process, many scans). */
const buckets = new Map<string, { remaining: number; resetMs: number }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait after a 429, from Retry-After (seconds) or X-RateLimit-Reset (epoch seconds). */
export function resetDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retry = headers.get("Retry-After");
  if (retry && /^\d+$/.test(retry)) return Number(retry) * 1000;
  const reset = headers.get("X-RateLimit-Reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - now) + 250;
  return undefined;
}

export interface NetlifyResponse {
  body: unknown;
  /** Page number of the Link rel="next" page, if any. */
  nextPage?: number;
}

/** GET one Netlify API resource and return its parsed JSON body plus the next page number. */
export async function netlifyGet(
  cfg: NetlifyConfig,
  path: string,
  query: Record<string, string | undefined> = {},
): Promise<NetlifyResponse> {
  const url = buildUrl(cfg, path, query);
  const bucketKey = new URL(cfg.baseUrl).origin;

  for (let attempt = 1; ; attempt++) {
    const bucket = buckets.get(bucketKey);
    if (bucket && bucket.remaining <= 1 && bucket.resetMs > Date.now()) {
      const wait = Math.min(bucket.resetMs - Date.now() + 250, MAX_RATE_WAIT_MS);
      log.info(`netlify: rate-limit bucket nearly empty; waiting ${wait} ms for reset`);
      await sleep(wait);
      buckets.delete(bucketKey);
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${cfg.token}`, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new NetlifyError(`GET ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const remaining = res.headers.get("X-RateLimit-Remaining");
    const reset = res.headers.get("X-RateLimit-Reset");
    if (remaining && reset && /^\d+$/.test(remaining) && /^\d+$/.test(reset)) {
      buckets.set(bucketKey, { remaining: Number(remaining), resetMs: Number(reset) * 1000 });
    }
    if (res.ok) {
      const text = await res.text();
      return { body: text ? JSON.parse(text) : null, nextPage: nextPageOf(res.headers.get("Link")) };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new NetlifyError(
        `GET ${redact(url)} failed with HTTP ${res.status}: ${await errorSummary(res)}`,
        res.status,
      );
    }
    await res.body?.cancel();
    const delay =
      res.status === 429 ? Math.min(resetDelayMs(res.headers) ?? 1000 * attempt, MAX_RATE_WAIT_MS) : 250 * 2 ** attempt;
    log.debug(`netlify: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** Netlify errors are `{"code": 401, "message": "..."}`; keep the message short. */
async function errorSummary(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { code?: unknown; message?: unknown; errors?: unknown };
    if (typeof j.message === "string") return j.message;
    return text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Show the path + query of a URL in errors (the token is never in a URL). */
function redact(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
