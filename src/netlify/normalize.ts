/**
 * The shared "web deploy platform" vocabulary (matching vgi-vercel): Netlify's raw deploy
 * states, contexts and timestamps mapped onto the normalized deployment states,
 * environments and `unified.runs` statuses.
 */

import type { Row } from "./table.ts";

export const PLATFORM = "netlify";

/** Netlify deploy `state` → normalized deployment state. */
export const STATE_OF_RAW: Record<string, string> = {
  new: "queued",
  pending_review: "queued",
  accepted: "queued",
  enqueued: "queued",
  retrying: "queued",
  building: "building",
  uploading: "building",
  uploaded: "building",
  preparing: "building",
  prepared: "building",
  processing: "building",
  processed: "building",
  ready: "ready",
  error: "error",
  rejected: "error",
  canceled: "canceled",
  cancelled: "canceled",
  skipped: "canceled",
};

/** Normalized deployment state → unified.runs status. */
export const RUN_STATUS_OF_STATE: Record<string, string> = {
  queued: "queued",
  building: "running",
  ready: "success",
  error: "failed",
  canceled: "cancelled",
};

export const rawStateOf = (d: Row): string | null => (typeof d.state === "string" && d.state ? d.state : null);

/** Netlify reports a cancelled build as state=error with error_message "Canceled build". */
const isCanceled = (d: Row): boolean =>
  typeof d.error_message === "string" && /^cancel+ed\b/i.test(d.error_message.trim());

export function stateOf(d: Row): string | null {
  const raw = rawStateOf(d);
  if (!raw) return null;
  if (d.skipped === true) return "canceled";
  if (raw === "error" && isCanceled(d)) return "canceled";
  return STATE_OF_RAW[raw.toLowerCase()] ?? null;
}

export function runStatusOf(d: Row): string {
  if (d.skipped === true) return "skipped";
  const s = stateOf(d);
  // Every row needs a status; an unknown future state is closest to "queued".
  return (s && RUN_STATUS_OF_STATE[s]) ?? "queued";
}

/**
 * The raw Netlify states that can produce the given normalized values (in `table`:
 * a deployments `state`, or a unified.runs `status` when `table` maps state → status).
 * Undefined when a value could also arise from a flag the API cannot filter on
 * (canceled / skipped come from error_message / skipped, not from `state`).
 */
export function rawStatesFor(values: string[], table?: Record<string, string>): string[] | undefined {
  const out = new Set<string>();
  for (const v of values) {
    const states = Object.entries(table ?? {})
      .filter(([, s]) => s === v)
      .map(([st]) => st);
    if (!table) states.push(v);
    if (states.includes("canceled") || v === "skipped") return undefined;
    const raws = Object.entries(STATE_OF_RAW)
      .filter(([raw, s]) => states.includes(s) && raw !== "canceled" && raw !== "cancelled" && raw !== "skipped")
      .map(([raw]) => raw);
    if (raws.length === 0) return undefined;
    for (const r of raws) out.add(r);
  }
  return out.size ? [...out].sort() : undefined;
}

/** Netlify `context` (production / deploy-preview / branch-deploy / …) → production or preview. */
export function environmentOf(d: Row): string {
  return d.context === "production" ? "production" : "preview";
}

/** Epoch ms of an ISO timestamp field, or null. */
export function ms(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** When the deploy became ready: published_at, else updated_at of a ready deploy. */
export function readyMs(d: Row): number | null {
  if (rawStateOf(d) !== "ready") return null;
  return ms(d.published_at) ?? ms(d.updated_at);
}

/** When the deploy ended: ready, or the last update of a failed / canceled / skipped deploy. */
export function endedMs(d: Row): number | null {
  const s = stateOf(d);
  if (s === "ready") return readyMs(d);
  if (s === "error" || s === "canceled") return ms(d.updated_at);
  return null;
}

/** Build time in seconds: Netlify's `deploy_time`. */
export const buildSeconds = (d: Row): number | null =>
  typeof d.deploy_time === "number" && Number.isFinite(d.deploy_time) ? d.deploy_time : null;

/**
 * When the build started. Netlify has no build-start field on a deploy; it is derived as
 * (ready or ended) − deploy_time, so it is NULL until the deploy finishes.
 */
export function buildingMs(d: Row): number | null {
  const end = endedMs(d);
  const secs = buildSeconds(d);
  return end != null && secs != null ? end - secs * 1000 : null;
}

/** The deploy's own URL (https://<id>--<site>.netlify.app). */
export const deployUrl = (d: Row): string | null =>
  (typeof d.deploy_ssl_url === "string" && d.deploy_ssl_url) ||
  (typeof d.deploy_url === "string" && d.deploy_url) ||
  null;

/** The Netlify app page of the deploy (admin_url is the site's admin page). */
export function inspectorUrl(d: Row): string | null {
  const admin = typeof d.admin_url === "string" ? d.admin_url.replace(/\/+$/, "") : null;
  return admin && typeof d.id === "string" ? `${admin}/deploys/${d.id}` : null;
}

/** unified.runs trigger: event (git push / pull request), manual (CLI / drag-and-drop), or NULL. */
export function triggerOf(d: Row): string | null {
  if (d.manual_deploy === true) return "manual";
  if (typeof d.review_id === "number" || (typeof d.commit_ref === "string" && d.commit_ref)) return "event";
  if (d.manual_deploy === false) return "other";
  return null;
}

/** A URL reduced to its host, for hooks whose full URL embeds a secret token. */
export function hostOf(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  try {
    return new URL(v).host || null;
  } catch {
    return null;
  }
}

/** Env var value contexts → shared targets (production / preview / development). */
export function targetsOf(contexts: string[]): string[] {
  const out = new Set<string>();
  for (const c of contexts) {
    if (c === "all") {
      out.add("production");
      out.add("preview");
      out.add("development");
    } else if (c === "production") out.add("production");
    else if (c === "deploy-preview" || c === "branch-deploy" || c === "branch") out.add("preview");
    else if (c === "dev" || c === "dev-server") out.add("development");
  }
  return ["production", "preview", "development"].filter((t) => out.has(t));
}
