/**
 * Discovery metadata: the catalog, its two schemas (`main`, `unified`) and the helpers
 * every table uses (objectTags, column).
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these tags.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "netlify";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-netlify";

/** Categories of the `main` schema. Every object's `vgi.category` must name one of these. */
export const SCHEMA_CATEGORIES = [
  { name: "account", title: "Accounts", description: "Netlify accounts (teams), plans and build-minute usage." },
  { name: "sites", title: "Sites", description: "Sites, their build settings and deployed functions." },
  {
    name: "deployments",
    title: "Deploys and Builds",
    description: "Deploys, deploy detail, deploy summary messages and builds.",
  },
  { name: "forms", title: "Forms", description: "Netlify Forms and their submissions." },
  {
    name: "dns",
    title: "Domains, DNS and TLS",
    description: "Site hostnames, Netlify DNS zones and records, TLS certificates.",
  },
  {
    name: "config",
    title: "Configuration",
    description: "Environment variable names, notification hooks, build hooks and split tests.",
  },
  { name: "team", title: "Team", description: "Team members and the account audit log." },
] as const;

/** Categories of the `unified` schema. */
export const UNIFIED_CATEGORIES = [
  { name: "runs", title: "Runs", description: "Deploys in the cross-orchestrator unified.runs shape." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"] | (typeof UNIFIED_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Netlify API reference](https://open-api.netlify.com/) — the API v1 endpoints this worker reads\n" +
  "- [Get started with the Netlify API](https://docs.netlify.com/api/get-started/) — authentication, pagination and rate limits\n" +
  "- [Personal access tokens](https://app.netlify.com/user/applications#personal-access-tokens)\n" +
  "- [Deploy contexts](https://docs.netlify.com/site-deploys/overview/#deploy-contexts) and [environment variables](https://docs.netlify.com/environment-variables/overview/)";

export const CATALOG_COMMENT =
  "Netlify sites, deploys, builds, forms, functions, DNS, TLS certificates, environment variable names, hooks, members and audit log as SQL, read-only from the Netlify API.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to Netlify through the Netlify API v1. Reach for it to answer questions about a " +
  "Netlify estate: which sites exist and how they build (repo, branch, build command, publish dir), which " +
  "deploys failed or are slow (deployments, deploy(), build_logs(), builds, build_stats), which domains, DNS " +
  "records and TLS certificates each site uses and when certificates expire, which environment variable NAMES " +
  "are defined where (values are never read), which notifications and build hooks exist (URLs reduced to host), " +
  "forms and submission counts, deployed functions, split tests, team members and the audit log. Tables live in " +
  "netlify.main; netlify.unified.runs exposes deploys in the cross-orchestrator runs shape. Column names of " +
  "projects, deployments, domains, build_logs, env_var_names and team_members follow the shared web-deploy " +
  "vocabulary of the Vercel worker, so the two UNION. Needs a `netlify` secret: CREATE SECRET (TYPE netlify, " +
  "TOKEN '<personal access token>'). Filters on site, site_id / project, project_id, environment, state, branch, " +
  "event, log_type and account push into the API; time lower bounds stop newest-first paging early.";

export const CATALOG_DOC_MD =
  "# Netlify\n\n" +
  "**Your Netlify sites, deploys and configuration as DuckDB tables.** Query deploy failures and build times " +
  "across every site, audit custom domains, HTTPS and certificate expiry, inventory environment variable " +
  "names, hooks and team members, and join deploys with other CI/CD systems through `unified.runs`.\n\n" +
  "Authenticate with a `netlify` secret holding a personal access token (`TOKEN`); `BASE_URL` is optional.\n\n" +
  "Read-only: the worker only issues GET requests. Secrets stay secret: environment variable values, hook " +
  "URLs, site passwords and build-env values are never returned; form submission contents only on request.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Netlify API v1 resources as catalog tables, plus three table functions that take an id (a deploy, its " +
  "build log, or a form's submissions, whose contents are only returned on request). Resources fall into " +
  "three scopes. Account-wide tables (accounts, sites, domains, DNS zones) are one listing each. Per-site " +
  "tables (deploys, builds, forms, functions, certificates, environment variable names, hooks, split tests) " +
  "read every site, one request each, unless you filter on site / site_id (or project / project_id in the " +
  "tables that use the shared web-deploy vocabulary) — do that whenever you can. Per-account tables (build " +
  "stats, team members, audit events) accept account_id / account_slug, and DNS records accept zone_id / domain.";

export const SCHEMA_COMMENT =
  "Netlify sites, deploys, builds, forms, functions, DNS, TLS, configuration and team data.";

export const SCHEMA_DOC_MD =
  "## main\n\nEvery Netlify API v1 resource this worker reads, as tables, plus table functions for one " +
  "deploy, its build log and a form's submissions.\n\n" +
  "- Filter per-site tables on `site` / `site_id` (`project` / `project_id` in the shared-vocabulary tables); " +
  "unfiltered, they make one request per site.\n" +
  "- `deployments` pushes `environment = 'production'`, `state`, `branch` into the API.";

export const UNIFIED_DOC_LLM =
  "Cross-orchestrator tables. `unified.runs` lists Netlify deploys with exactly the columns every orchestrator " +
  "and CI worker (Airflow, Dagster, Prefect, Temporal, Databricks, dbt, GitHub, Vercel) uses, so you can " +
  "UNION ALL them: orchestrator, run_id, pipeline, status, raw_status, trigger, queued_at, started_at, " +
  "ended_at, duration_seconds, url.";

export const UNIFIED_COMMENT = "Netlify deploys in the cross-orchestrator unified runs shape.";

export const UNIFIED_DOC_MD =
  "## unified\n\nNetlify deploys as `runs`, in the column shape every orchestrator and CI worker shares, so " +
  "they can be combined with `UNION ALL`.\n\n" +
  "Each deploy is one run: `pipeline` is the site name, `status` is one of queued, running, success, failed, " +
  "cancelled or skipped, and `url` opens the deploy in the Netlify app. Use it for cross-platform delivery " +
  "dashboards; for Netlify-specific detail use `main.deployments`.";

export const AGENT_TEST_TASKS = [
  { name: "failed_deploys", prompt: "Which Netlify deploys failed? List the site and deploy id." },
  { name: "production_build_time", prompt: "What is the average production build time per Netlify site?" },
  { name: "custom_domains_no_force_ssl", prompt: "Which sites have a custom domain but do not force HTTPS?" },
  { name: "cert_expiry", prompt: "Which site's TLS certificate expires first, and when?" },
  { name: "env_var_count", prompt: "How many environment variables does each site define?" },
  { name: "busiest_form", prompt: "Which Netlify form has the most submissions?" },
  { name: "team_owners", prompt: "Who are the owners of the Netlify team?" },
  { name: "run_status_counts", prompt: "How many Netlify deploys are there per run status in the unified runs table?" },
  { name: "account_plans", prompt: "What plan is each Netlify account on, and how many sites does it use?" },
  { name: "security_audit_events", prompt: "Which security-type audit events were recorded for the acme team?" },
  { name: "build_hook_branches", prompt: "Which branches do the build hooks of the acme-web site build?" },
  {
    name: "failed_deploy_messages",
    prompt: "What warning and error messages did the deploy docs00000000000000000002 report?",
  },
  { name: "build_minutes_used", prompt: "How many build minutes has each Netlify account used this billing period?" },
  { name: "failed_builds", prompt: "How many builds failed on the acme-docs site?" },
  { name: "deploy_functions", prompt: "Which functions shipped in deploy docs00000000000000000001?" },
  { name: "mx_records", prompt: "What MX records are configured in Netlify DNS?" },
  { name: "zone_nameservers", prompt: "Which nameservers should each Netlify DNS zone be delegated to?" },
  { name: "domain_aliases", prompt: "Which domain aliases does each Netlify site have?" },
  {
    name: "contact_form_submissions",
    prompt: "How many submissions did the form form-contact receive in November 2026?",
  },
  { name: "go_functions", prompt: "Which deployed Netlify functions use the Go runtime?" },
  { name: "failure_notifications", prompt: "Which hosts receive deploy_failed notifications from Netlify sites?" },
  { name: "projects_by_provider", prompt: "How many Netlify projects are linked to each git provider?" },
  {
    name: "active_split_tests",
    prompt: "Which split tests are active and how is their traffic divided between branches?",
  },
];

/** Bind-only probes: each binds a table and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "deployments_columns",
    description: "The deployments columns (binds only; create a netlify secret and drop LIMIT 0 for rows)",
    sql: "SELECT project, environment, state, branch, created_at FROM netlify.main.deployments LIMIT 0",
  },
  {
    name: "runs_columns",
    description: "The unified.runs columns (binds only; create a netlify secret and drop LIMIT 0 for rows)",
    sql: "SELECT orchestrator, run_id, pipeline, status, queued_at FROM netlify.unified.runs LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Netlify Sites & Deploys",
  "vgi.subtitle": "Netlify sites, deploys, builds, DNS, TLS, env var names, hooks and team as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "netlify, jamstack, web hosting, deploys, deployments, builds, sites, dns, ssl, environment variables, devops, ci/cd",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Netlify API",
  domain: "devops",
  "vgi.keywords": keywordsArray("netlify, sites, deploys, builds, forms, functions, dns, ssl, env vars, hooks, team"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

export const UNIFIED_SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Unified Runs",
  domain: "devops",
  "vgi.keywords": keywordsArray("unified, runs, orchestrator, ci, cd, union, cross-platform"),
  "vgi.doc_llm": UNIFIED_DOC_LLM,
  "vgi.doc_md": UNIFIED_DOC_MD,
  "vgi.categories": JSON.stringify(UNIFIED_CATEGORIES),
};
