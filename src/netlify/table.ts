/**
 * One factory for every Netlify list endpoint.
 *
 * A spec names the columns (with a JSON extractor each), how arguments and pushed
 * filters become the requests ("phases") of a scan, and whether the endpoint pages.
 * The factory turns that into a VGI table function (or catalog table) that:
 *
 * - streams one Netlify page per Arrow batch;
 * - keeps its cursor (phase + next page number, parent queue) in serializable state,
 *   so a scan resumes on any process over HTTP and survives rate-limit pauses;
 * - reads the `netlify` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly;
 * - fans out over parents (sites, accounts, DNS zones) for per-parent endpoints;
 * - can stop a phase early (`stopAfter`), e.g. once a newest-first deploy list has
 *   passed the lower bound of a `created_at` range.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  struct,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, NetlifyError, netlifyGet, SECRET_TYPE } from "./client.ts";
import { type Constraint, constraintsOf, eqValues } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Row) => unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: Netlify JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string> };

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null || v === "" ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
export const asBigInt = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Netlify timestamps are ISO 8601 strings (an epoch-ms number is accepted too) → TIMESTAMPTZ µs. */
export function asTime(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return BigInt(Math.trunc(v)) * 1000n;
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

type Getter = string | ((r: Row) => unknown);
const read = (r: Row, g: Getter) => (typeof g === "string" ? at(r, g) : g(r));

function mkCol(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  get: (r: Row) => unknown,
  nullable = true,
): Col {
  return { name, type, sqlType, doc, get, nullable };
}

/** A typed field of a STRUCT column. */
export interface StructField {
  name: string;
  kind: "str" | "bool" | "int" | "num" | "time";
  get: Getter;
}

const STRUCT_KINDS = {
  str: { arrow: () => utf8(), sql: "VARCHAR", conv: asStr },
  bool: { arrow: () => bool, sql: "BOOLEAN", conv: asBool },
  int: { arrow: () => int32, sql: "INTEGER", conv: asInt },
  num: { arrow: () => float64(), sql: "DOUBLE", conv: asNum },
  time: { arrow: () => timestampMicros("UTC"), sql: "TIMESTAMP WITH TIME ZONE", conv: asTime },
} as const;

export const C = {
  str: (name: string, doc: string, g: Getter, nullable = true) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => asStr(read(r, g)), nullable),
  /** Like `str`, but an empty string stays '' (e.g. a DNS record name at the zone apex). */
  text: (name: string, doc: string, g: Getter) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => {
      const v = read(r, g);
      return typeof v === "string" ? v : asStr(v);
    }),
  /** A constant column, e.g. platform = 'netlify'. */
  constant: (name: string, doc: string, value: string) => mkCol(name, utf8(), "VARCHAR", doc, () => value, false),
  time: (name: string, doc: string, g: Getter) =>
    mkCol(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(read(r, g))),
  bool: (name: string, doc: string, g: Getter) => mkCol(name, bool, "BOOLEAN", doc, (r) => asBool(read(r, g))),
  int: (name: string, doc: string, g: Getter) => mkCol(name, int32, "INTEGER", doc, (r) => asInt(read(r, g))),
  bigint: (name: string, doc: string, g: Getter) => mkCol(name, int64(), "BIGINT", doc, (r) => asBigInt(read(r, g))),
  num: (name: string, doc: string, g: Getter) => mkCol(name, float64(), "DOUBLE", doc, (r) => asNum(read(r, g))),
  strList: (name: string, doc: string, g: Getter) =>
    mkCol(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(read(r, g))),
  json: (name: string, doc: string, g: Getter) => mkCol(name, utf8(), "JSON", doc, (r) => asJson(read(r, g))),
  /** A value of the parent the row was fetched under (site id, account slug …). */
  ctx: (name: string, doc: string, key: string, nullable = false) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null, nullable),
  structList: (name: string, doc: string, fields: StructField[], g: Getter) =>
    mkCol(
      name,
      list(struct(fields.map((f) => field(f.name, STRUCT_KINDS[f.kind].arrow())) as never)),
      `STRUCT(${fields.map((f) => `${f.name} ${STRUCT_KINDS[f.kind].sql}`).join(", ")})[]`,
      doc,
      (r) => {
        const v = read(r, g);
        if (!Array.isArray(v)) return null;
        return v.map((item) =>
          Object.fromEntries(fields.map((f) => [f.name, STRUCT_KINDS[f.kind].conv(read(item, f.get))])),
        );
      },
    ),
};

// --------------------------------------------------------------------- the factory

/** One request ("phase") of a scan. */
export interface PageRequest {
  path: string;
  query?: Record<string, string | undefined>;
  /** Per-phase values exposed to columns through `C.ctx` (e.g. the site id). */
  ctx?: Record<string, string>;
  /** Page with `page` / `per_page` and the Link header (default: the spec's `paged`). */
  paged?: boolean;
}

export interface ScanContext<A> {
  args: A;
  constraints: Constraint[];
}

export interface FnExample {
  sql: string;
  description: string;
}

/** A parent lookup selected by a pushed `= / IN` filter on `column` (or a named argument). */
export interface ParentKey {
  column: string;
  lookup: (value: string) => PageRequest;
  /** The parent rows of a lookup response (a single object, or a filtered list). */
  rows: (body: unknown, value: string) => Row[];
}

export interface Fanout<A> {
  keys: ParentKey[];
  /** A named argument that selects one parent, resolved with `keys[0]`. */
  arg?: string;
  parents: PageRequest;
  parentRows: (body: unknown) => Row[];
  parentCtx: (row: Row) => Record<string, string> | null;
  /** The requests to make for one parent. */
  children: (parent: Record<string, string>, scan: ScanContext<A>) => PageRequest[];
}

export interface NetlifyTableSpec<A> {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  /** Catalog schema the table lives in (catalog tables only; default main). */
  schemaName?: string;
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  columns: Col[];
  /** Columns that are a primary key (catalog tables). */
  primaryKey?: string[];
  /** Pull the rows out of a response body. */
  rows: (body: unknown, req: PageRequest) => Row[];
  /** Whether requests page with page / per_page (default false). */
  paged?: boolean;
  perPage?: number;
  /** One request per phase (unused with `fanout`). */
  requests?: (scan: ScanContext<A>) => PageRequest[];
  fanout?: Fanout<A>;
  /** True when no later page of this phase can match (newest-first lists past a time bound). */
  stopAfter?: (rows: Row[], scan: ScanContext<A>) => boolean;
  /** A 404 (or plan-gated 401/403 when `forbiddenEmpty`) means "nothing here" → zero rows. */
  notFoundEmpty?: boolean;
  forbiddenEmpty?: boolean;
  /** Text appended to doc_md describing what pushes down. */
  pushdown?: string;
  examples: FnExample[];
}

interface ScanState {
  phase: number;
  /** Page number of the next request of the current phase (1 = first). */
  page: number;
  /** Fan-out: JSON array of pending parent contexts (the head is being read). */
  queue: string;
  /** Fan-out: next page of the parent listing. */
  parentPage: number;
  parentDone: boolean;
}

export const DEFAULT_PER_PAGE = 100;

/** The Arrow output schema of a spec (column comments ride along as field metadata). */
function outputSchemaOf<A>(spec: NetlifyTableSpec<A>) {
  return schema(
    spec.columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

/** Discovery tags shared by a spec's function or table. */
function tagsOf<A>(spec: NetlifyTableSpec<A>): Record<string, string> {
  return {
    domain: "devops",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

/**
 * A spec with no arguments exposed as a catalog table (`SELECT … FROM netlify.main.sites`).
 * The scan function keeps every capability (pushdown, paging, secrets) and is table-only.
 */
export function defineNetlifyCatalogTable(spec: NetlifyTableSpec<Record<string, never>>): TableDescriptor {
  const fn = defineNetlifyTable({ ...spec, name: `${spec.name}_scan` });
  const schemaPath = [spec.schemaName ?? "main"];
  const records = spec.columns
    .filter((c) => c.nullable === false)
    .map((c) =>
      constraintRecord({
        schemaPath,
        table: spec.name,
        id: `${c.name}_not_null`,
        kind: "NOT_NULL",
        columns: [[c.name]],
        enforcement: "ENFORCED",
        validation: "ALL_ROWS",
      }),
    );
  if (spec.primaryKey) {
    records.push(
      constraintRecord({
        schemaPath,
        table: spec.name,
        id: "pk",
        kind: "PRIMARY_KEY",
        columns: spec.primaryKey.map((c) => [c]),
        enforcement: "ENFORCED",
        validation: "ALL_ROWS",
      }),
    );
  }
  return {
    name: spec.name,
    comment: spec.description,
    columns: outputSchemaOf(spec),
    function: fn,
    constraints: records,
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

const parse = <T>(s: string, dflt: T): T => (s ? (JSON.parse(s) as T) : dflt);

export function defineNetlifyTable<A extends Record<string, unknown>>(spec: NetlifyTableSpec<A>): VgiFunction {
  const outSchema = outputSchemaOf(spec);
  const perPage = String(spec.perPage ?? DEFAULT_PER_PAGE);

  return defineTableFunction<A, ScanState>({
    name: spec.name,
    description: spec.description,
    args: spec.args ?? {},
    argDocs: spec.argDocs,
    argDefaults: spec.argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Netlify returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({ phase: 0, page: 1, queue: "", parentPage: 1, parentDone: false }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const scan: ScanContext<A> = { args: params.args, constraints: constraintsOf(params.pushdownFilters) };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);

      /** GET one page of `req` (null = an empty-by-design 404/403). */
      const get = async (req: PageRequest, page: number) => {
        const paged = req.paged ?? spec.paged ?? false;
        const query = paged ? { ...req.query, page: String(page), per_page: perPage } : { ...req.query };
        try {
          return await netlifyGet(cfg, req.path, query);
        } catch (err) {
          if (err instanceof NetlifyError) {
            if (spec.notFoundEmpty && err.status === 404) return null;
            if (spec.forbiddenEmpty && (err.status === 403 || err.status === 401)) return null;
          }
          throw err;
        }
      };

      /** Read one page of the current phase; advance the cursor; emit. True when rows went out. */
      const page = async (req: PageRequest, onDone: () => void): Promise<boolean> => {
        const res = await get(req, state.page);
        const rows = res == null ? [] : spec.rows(res.body, req);
        const paged = req.paged ?? spec.paged ?? false;
        const next = paged && res?.nextPage !== undefined && rows.length > 0 ? res.nextPage : undefined;
        if (next !== undefined && next > state.page && !spec.stopAfter?.(rows, scan)) {
          state.page = next;
        } else {
          state.page = 1;
          onDone();
        }
        return emit(rows, req.ctx ?? {});
      };

      const emit = (rows: Row[], ctx: Record<string, string>): boolean => {
        if (rows.length === 0) return false;
        const tagged = rows.map((r) => ({ ...r, __ctx: { ...ctx, ...r.__ctx } }));
        const cols: Record<string, unknown[]> = {};
        for (const f of params.outputSchema.fields) {
          const c = spec.columns.find((x) => x.name === f.name);
          cols[f.name] = c ? tagged.map((r) => c.get(r)) : tagged.map(() => null);
        }
        out.emit(batchFromColumns(cols, params.outputSchema));
        return true;
      };

      const fan = spec.fanout;
      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        if (fan) {
          let queue = parse<Record<string, string>[]>(state.queue, []);
          if (queue.length === 0) {
            if (state.parentDone) {
              out.finish();
              return;
            }
            queue = await refillParents(fan, scan, state, get);
            state.queue = JSON.stringify(queue);
            state.phase = 0;
            state.page = 1;
            continue;
          }
          const head = queue[0] as Record<string, string>;
          const reqs = fan.children(head, scan);
          const req = reqs[state.phase];
          if (!req) {
            state.queue = JSON.stringify(queue.slice(1));
            state.phase = 0;
            state.page = 1;
            continue;
          }
          const emitted = await page({ ...req, ctx: { ...head, ...req.ctx } }, () => {
            state.phase += 1;
          });
          if (emitted) return;
          continue;
        }
        const phases = spec.requests?.(scan) ?? [];
        const phase = phases[state.phase];
        if (!phase) {
          out.finish();
          return;
        }
        if (
          await page(phase, () => {
            state.phase += 1;
          })
        )
          return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}

/** Fill the fan-out queue: explicit parents (resolved once) or the next page of the listing. */
async function refillParents<A extends Record<string, unknown>>(
  fan: Fanout<A>,
  scan: ScanContext<A>,
  state: ScanState,
  get: (req: PageRequest, page: number) => Promise<{ body: unknown; nextPage?: number } | null>,
): Promise<Record<string, string>[]> {
  const argVal = fan.arg ? scan.args[fan.arg] : undefined;
  let explicit: { key: ParentKey; values: string[] } | undefined;
  if (typeof argVal === "string" && argVal && fan.keys[0]) explicit = { key: fan.keys[0], values: [argVal] };
  for (const key of fan.keys) {
    if (explicit) break;
    const values = eqValues(scan.constraints, key.column);
    if (values) explicit = { key, values };
  }
  if (explicit) {
    state.parentDone = true;
    const out: Record<string, string>[] = [];
    const seen = new Set<string>();
    for (const v of explicit.values) {
      let res: { body: unknown } | null;
      try {
        const req = explicit.key.lookup(v);
        res = await get({ ...req, paged: req.paged ?? false }, 1);
      } catch (err) {
        if (err instanceof NetlifyError && err.status === 404) continue;
        throw err;
      }
      for (const row of res == null ? [] : explicit.key.rows(res.body, v)) {
        const ctx = fan.parentCtx(row);
        const id = JSON.stringify(ctx);
        if (ctx && !seen.has(id)) {
          seen.add(id);
          out.push(ctx);
        }
      }
    }
    return out;
  }
  const paged = fan.parents.paged ?? false;
  const res = await get({ ...fan.parents, paged }, state.parentPage);
  const rows = res == null ? [] : fan.parentRows(res.body);
  const next = paged && res?.nextPage !== undefined && rows.length > 0 ? res.nextPage : undefined;
  if (next !== undefined && next > state.parentPage) state.parentPage = next;
  else state.parentDone = true;
  return rows.map(fan.parentCtx).filter((x): x is Record<string, string> => x != null);
}
