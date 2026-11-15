// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CATALOG } from "../src/catalog.ts";
import {
  configFromSecrets,
  type NetlifyConfig,
  netlifyGet,
  nextPageOf,
  normalizeBaseUrl,
  parseLinkHeader,
  resetDelayMs,
} from "../src/netlify/client.ts";
import {
  buildingMs,
  environmentOf,
  hostOf,
  RUN_STATUS_OF_STATE,
  rawStatesFor,
  runStatusOf,
  stateOf,
  targetsOf,
  triggerOf,
} from "../src/netlify/normalize.ts";
import { type Constraint, eqValue, eqValues, timeBounds } from "../src/netlify/pushdown.ts";
import {
  deployLogRows,
  deployRequests,
  envVarRow,
  functionRows,
  siteDomains,
  submissionRows,
} from "../src/netlify/resources.ts";

const ROOT = join(import.meta.dir, "..");

test("parseLinkHeader / nextPageOf: Netlify's next + last links", () => {
  const h =
    '<https://api.netlify.com/api/v1/sites?page=2&per_page=100>; rel="next", <https://api.netlify.com/api/v1/sites?page=5&per_page=100>; rel="last"';
  expect(parseLinkHeader(h).last).toBe("https://api.netlify.com/api/v1/sites?page=5&per_page=100");
  expect(nextPageOf(h)).toBe(2);
  expect(nextPageOf('<https://x/y?page=5>; rel="last"')).toBeUndefined();
  expect(nextPageOf(null)).toBeUndefined();
});

test("base_url: https required except for loopback fixtures; trailing slash dropped", () => {
  expect(normalizeBaseUrl("https://api.netlify.com/api/v1/")).toBe("https://api.netlify.com/api/v1");
  expect(normalizeBaseUrl("http://127.0.0.1:8080/api/v1")).toBe("http://127.0.0.1:8080/api/v1");
  expect(() => normalizeBaseUrl("http://api.netlify.com/api/v1")).toThrow(/https/);
  expect(() => normalizeBaseUrl("nope")).toThrow(/not a URL/);
});

test("configFromSecrets: needs a token; default base URL", () => {
  expect(() => configFromSecrets({})).toThrow(/no netlify secret/);
  expect(() => configFromSecrets({ s: { type: "netlify" } })).toThrow(/TOKEN/);
  expect(configFromSecrets({ s: { type: "netlify", token: "t" } })).toEqual({
    baseUrl: "https://api.netlify.com/api/v1",
    token: "t",
  });
});

test("resetDelayMs: Retry-After first, then X-RateLimit-Reset (epoch seconds)", () => {
  expect(resetDelayMs(new Headers({ "Retry-After": "3" }))).toBe(3000);
  expect(resetDelayMs(new Headers({ "X-RateLimit-Reset": "1010" }), 1_000_000)).toBe(10_250);
  expect(resetDelayMs(new Headers())).toBeUndefined();
});

test("state normalization: raw states, canceled builds, skipped deploys", () => {
  expect(stateOf({ state: "uploading" })).toBe("building");
  expect(stateOf({ state: "enqueued" })).toBe("queued");
  expect(stateOf({ state: "rejected" })).toBe("error");
  expect(stateOf({ state: "error", error_message: "Canceled build" })).toBe("canceled");
  expect(stateOf({ state: "ready", skipped: true })).toBe("canceled");
  expect(runStatusOf({ state: "ready", skipped: true })).toBe("skipped");
  expect(runStatusOf({ state: "ready" })).toBe("success");
  expect(runStatusOf({ state: "who-knows" })).toBe("queued");
  expect(environmentOf({ context: "production" })).toBe("production");
  expect(environmentOf({ context: "branch-deploy" })).toBe("preview");
});

test("rawStatesFor: pushable only when every matching raw state is a state filter", () => {
  expect(rawStatesFor(["error"])).toEqual(["error", "rejected"]);
  expect(rawStatesFor(["ready"])).toEqual(["ready"]);
  expect(rawStatesFor(["canceled"])).toBeUndefined();
  expect(rawStatesFor(["failed"], RUN_STATUS_OF_STATE)).toEqual(["error", "rejected"]);
  expect(rawStatesFor(["skipped"], RUN_STATUS_OF_STATE)).toBeUndefined();
  expect(rawStatesFor(["nonsense"])).toBeUndefined();
});

test("derived timings and trigger", () => {
  const d = { state: "ready", published_at: "2026-11-10T08:01:00Z", deploy_time: 55 };
  expect(buildingMs(d)).toBe(Date.parse("2026-11-10T08:00:05Z"));
  expect(buildingMs({ state: "building" })).toBeNull();
  expect(triggerOf({ manual_deploy: true })).toBe("manual");
  expect(triggerOf({ commit_ref: "abc", manual_deploy: false })).toBe("event");
  expect(triggerOf({ manual_deploy: false })).toBe("other");
});

test("pushdown helpers", () => {
  const cs: Constraint[] = [
    { kind: "in", column: "state", values: ["ready", "error"] },
    { kind: "cmp", column: "state", op: "eq", value: "ready" },
    { kind: "cmp", column: "created_at", op: "ge", value: 1_000_000_000n },
  ];
  expect(eqValues(cs, "state")).toEqual(["ready"]);
  expect(eqValue(cs, "branch")).toBeUndefined();
  expect(timeBounds(cs, "created_at")).toEqual({ since: 999_999, until: undefined });
});

test("deployRequests: one request per raw state; production and branch ride along", () => {
  const site = { site_id: "s1" };
  const cols = {
    project: "project",
    projectId: "project_id",
    environment: "environment",
    state: "state",
    rawState: "raw_state",
    branch: "branch",
    created: "created_at",
  };
  const cs: Constraint[] = [
    { kind: "cmp", column: "environment", op: "eq", value: "production" },
    { kind: "cmp", column: "state", op: "eq", value: "error" },
    { kind: "cmp", column: "branch", op: "eq", value: "main" },
  ];
  expect(deployRequests(site, cs, cols).map((r) => r.query)).toEqual([
    { production: "true", branch: "main", state: "error" },
    { production: "true", branch: "main", state: "rejected" },
  ]);
  // environment = 'preview' has no API flag: nothing is sent.
  const preview = deployRequests(site, [{ kind: "cmp", column: "environment", op: "eq", value: "preview" }], cols);
  expect(preview).toHaveLength(1);
  expect(preview[0]?.query).toEqual({ production: undefined, branch: undefined, state: undefined });
  // Contradictory raw_state and state → no request at all.
  const none: Constraint[] = [
    { kind: "cmp", column: "state", op: "eq", value: "ready" },
    { kind: "cmp", column: "raw_state", op: "eq", value: "error" },
  ];
  expect(deployRequests(site, none, cols)).toEqual([]);
});

test("envVarRow: never carries a value", () => {
  const row = envVarRow({
    key: "K",
    scopes: ["builds"],
    is_secret: true,
    values: [
      { id: "1", value: "TOP-SECRET", context: "production" },
      { id: "2", value: "ALSO-SECRET", context: "branch", context_parameter: "beta" },
    ],
  });
  expect(JSON.stringify(row)).not.toContain('SECRET"');
  expect(JSON.stringify(row)).not.toContain("TOP-SECRET");
  expect(row.targets).toEqual(["production", "preview"]);
  expect(row.git_branch).toBe("beta");
  expect(row.type).toBe("secret");
  expect(targetsOf(["all"])).toEqual(["production", "preview", "development"]);
});

test("submissionRows: PII only on request", () => {
  const body = [{ id: "s", number: 1, email: "a@b.c", body: "hi", data: { x: 1 } }];
  expect(submissionRows(body, false)).toEqual([{ id: "s", number: 1 }]);
  expect(submissionRows(body, true)[0]?.email).toBe("a@b.c");
});

test("hostOf: hook URLs reduced to their host", () => {
  expect(hostOf("https://hooks.example.com/services/T/B/secret?x=1")).toBe("hooks.example.com");
  expect(hostOf("not a url")).toBeNull();
  expect(hostOf(undefined)).toBeNull();
});

test("siteDomains, deployLogRows, functionRows", () => {
  const domains = siteDomains({ id: "1", name: "web", custom_domain: "www.a.dev", domain_aliases: ["a.dev"] });
  expect(domains.map((d) => [d.domain, d.kind])).toEqual([
    ["web.netlify.app", "netlify_subdomain"],
    ["www.a.dev", "primary"],
    ["a.dev", "alias"],
  ]);
  const logs = deployLogRows({
    id: "d",
    error_message: "boom",
    summary: { messages: [{ type: "warning", title: "t", description: "x", details: "y" }] },
  });
  expect(logs.map((l) => [l.__line, l.type, l.text])).toEqual([
    [1, "warning", "x\ny"],
    [2, "error", "boom"],
  ]);
  expect(functionRows([{ id: "d", functions: [{ n: "f", r: "go", s: 10 }] }])[0]).toMatchObject({
    deploy_id: "d",
    name: "f",
    runtime: "go",
    size_bytes: 10,
  });
});

test("catalog: main + unified schemas, every table documented", () => {
  const [main, unified] = CATALOG.schemas;
  expect(main?.tables?.map((t) => t.name)).toContain("deployments");
  expect(unified?.tables?.map((t) => t.name)).toEqual(["runs"]);
  for (const t of [...(main?.tables ?? []), ...(unified?.tables ?? [])]) {
    expect(t.comment).toBeTruthy();
    expect(t.tags?.["vgi.doc_llm"]).toBeTruthy();
  }
  const env = main?.tables?.find((t) => t.name === "env_var_names");
  expect(env?.columns?.fields.map((f) => f.name)).not.toContain("value");
});

describe("against the replay server", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let cfg: NetlifyConfig;

  beforeAll(async () => {
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`replay server did not report a port: ${text}`);
    cfg = { baseUrl: `http://127.0.0.1:${port}/api/v1`, token: "test-token" };
  });

  afterAll(() => {
    mock?.kill();
  });

  test("netlifyGet: pages via the Link header", async () => {
    const res = await netlifyGet(cfg, "/sites/site-0001-acme-web/deploys", { page: "1", per_page: "100" });
    expect((res.body as unknown[]).length).toBe(100);
    expect(res.nextPage).toBe(2);
    const last = await netlifyGet(cfg, "/sites/site-0001-acme-web/deploys", { page: "3", per_page: "100" });
    expect((last.body as unknown[]).length).toBe(50);
    expect(last.nextPage).toBeUndefined();
  });

  test("netlifyGet: retries a 429 after Retry-After", async () => {
    const t0 = Date.now();
    const res = await netlifyGet(cfg, "/dns_zones");
    expect((res.body as unknown[]).length).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  test("netlifyGet: 401 and unknown parameters fail with the status", async () => {
    await expect(netlifyGet({ ...cfg, token: "wrong" }, "/accounts")).rejects.toThrow(/HTTP 401/);
    await expect(netlifyGet(cfg, "/accounts", { bogus: "1" })).rejects.toThrow(/HTTP 422/);
  });
});
