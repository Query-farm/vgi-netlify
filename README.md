<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Netlify Sites, Deploys, Builds, DNS and Team Data in DuckDB

> **vgi-netlify** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-netlify/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-netlify/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Netlify as SQL, read-only, through the [Netlify API v1](https://open-api.netlify.com/):
every site and how it builds, every deploy and why it failed, builds and build minutes,
domains, Netlify DNS and TLS certificates, environment variable **names**, notification
and build hooks, forms, functions, split tests, team members and the audit log.

```sql
CREATE SECRET netlify (TYPE netlify, TOKEN 'nfp_…');

-- Failed vs total deploys per site this month (paging stops at the date).
SELECT project, count(*) FILTER (WHERE state = 'error') AS failed, count(*) AS total
FROM netlify.main.deployments
WHERE created_at >= TIMESTAMPTZ '2026-11-01 00:00:00+00'
GROUP BY project ORDER BY failed DESC;

-- Certificates expiring in the next 30 days.
SELECT site, domains, expires_at FROM netlify.main.ssl_certificates
WHERE expires_at < now() + INTERVAL 30 DAY ORDER BY expires_at;
```

## Tables and functions

Tables live in `netlify.main` (plus `netlify.unified.runs`). Per-site tables read every
site, one API call each, unless you filter on the site: `site` / `site_id`, or `project`
/ `project_id` in the shared-vocabulary tables (`=` or `IN`). Per-account tables take
`account_id` / `account_slug` the same way.

| Object | Netlify endpoint | What pushes down |
|---|---|---|
| `accounts` | `GET /accounts` | — (billing contacts are not exposed) |
| `sites` | `GET /sites?filter=all` (paged) | `name` (`=`) → `name`; `account_slug` (`=`) → `GET /{account_slug}/sites` |
| `projects` | `GET /sites` | shared-vocabulary view of `sites`; `name` (`=`) |
| `domains` | `GET /sites` | one row per hostname (netlify.app subdomain, custom domain, aliases, branch/preview domains); `project` (`=`) |
| `deployments` | `GET /sites/{id}/deploys` (paged, newest first) | site; `environment = 'production'` → `production=true`; `state` / `raw_state` (`=`, `IN`) → `state` (one request per raw state); `branch` → `branch`; `created_at` lower bound → **early stop** |
| `deploy(deployment_id)` | `GET /deploys/{id}` | — (summary messages, functions, schedules; zero rows if not found) |
| `build_logs(deployment_id)` | `GET /deploys/{id}` | — (see below) |
| `builds` | `GET /sites/{id}/builds` (paged) | site; `created_at` lower bound → early stop |
| `build_stats` | `GET /{account_id}/builds/status` | account |
| `forms` | `GET /sites/{id}/forms` | site (field definitions and counts only) |
| `form_submissions(form_id, include_contents := false)` | `GET /forms/{id}/submissions` (paged) | `created_at` lower bound → early stop |
| `functions` | `GET /sites/{id}/functions` | site |
| `dns_zones` | `GET /dns_zones` | `account_slug` (`=`) |
| `dns_records` | `GET /dns_zones/{id}/dns_records` | `zone_id` / `domain` (`=`, `IN`) |
| `ssl_certificates` | `GET /sites/{id}/ssl` | site (sites without a certificate return no row) |
| `env_var_names` | `GET /accounts/{account_id}/env?site_id=…` | `project_id` / `project` — **keys only, never values** |
| `hooks` | `GET /hooks?site_id=…` | site; `event` (`=`) → `event` — target URL reduced to its host |
| `build_hooks` | `GET /sites/{id}/build_hooks` | site — hook URL (a secret) reduced to its host |
| `split_tests` | `GET /sites/{id}/traffic_splits` | site |
| `team_members` | `GET /{account_slug}/members` | account |
| `audit_events` | `GET /accounts/{id}/audit` (paged, newest first) | account; `log_type` (`=`); `timestamp` lower bound → early stop; plans without an audit log return no rows |
| `unified.runs` | `GET /sites/{id}/deploys` | `pipeline` (site name), `status` / `raw_status` → `state`, `queued_at` lower bound → early stop |

Every pushed filter only narrows the request: the SDK re-applies the full `WHERE` clause
to what comes back, so results are exact whether or not a predicate could be sent.

**Time ranges.** The deploy, build, submission and audit endpoints take no date filter.
They list newest first, so the worker applies a time lower bound itself and stops paging
as soon as a page ends before it (a one-week window over a site with thousands of deploys
reads one page). An upper bound is applied in the worker without saving requests.

**Build logs.** Netlify's public API has no endpoint for the raw build log. The Netlify
app streams it separately. `build_logs(deployment_id)` returns what the API does expose
for a deploy: one row per deploy summary message (info / warning / error) and, for a
failed deploy, a final row with its `error_message`. The columns follow the shared
vocabulary so the table unions with Vercel's `build_logs`.

## Shared web-deploy vocabulary

`projects`, `deployments`, `domains`, `build_logs`, `env_var_names` and `team_members` use
the same column names and types as [vgi-vercel](https://github.com/Query-farm/vgi-vercel),
so the two platforms union:

- `deployments`: the first 16 columns are, in order, `platform, id, project, environment
  (production | preview), state (queued | building | ready | error | canceled), raw_state,
  branch, commit_sha, commit_message, creator, created_at, building_at, ready_at,
  build_duration_seconds, url, inspector_url`, so `UNION ALL` works positionally on them.
  Netlify extras follow (`project_id`, `context`, `build_id`, `error_message`, `review_id`,
  `draft`, `skipped`, `locked`, `published_at`, …).
- The other tables share their key columns (`platform`, `project`, `project_id`,
  `domain`, `key`, `targets`, `team_id`, `user_id`, `email`, `name`, `role`, …); combine
  them with `UNION ALL BY NAME`.

Netlify mapping notes:

- `environment`: context `production` becomes production; deploy previews and branch
  deploys become preview.
- `state`: `new` / `pending_review` / `accepted` / `enqueued` / `retrying` → queued;
  `building` … `processed` → building; `ready` → ready; `error` / `rejected` → error;
  an error whose message is "Canceled build", or a skipped deploy, → canceled.
- `ready_at` is `published_at`, or `updated_at` for a ready preview.
  `build_duration_seconds` is Netlify's `deploy_time`. `building_at` is derived as
  `ready_at − deploy_time`, because Netlify reports no build-start time.

`netlify.unified.runs` has exactly the `unified.runs` columns the orchestrator workers
share (`orchestrator = 'netlify'`, `pipeline` = site name, status `queued | running |
success | failed | cancelled | skipped`, `trigger` `event | manual | other`).

```sql
SELECT * FROM netlify.unified.runs
UNION ALL SELECT * FROM vercel.unified.runs
UNION ALL SELECT * FROM github.unified.runs;
```

## Authentication

Create one `netlify` secret with a personal access token (*User settings → Applications →
Personal access tokens*) or an OAuth access token. It is sent as `Authorization: Bearer`.
`BASE_URL` is optional (default `https://api.netlify.com/api/v1`; `https://` only, except
`http://127.0.0.1` / `localhost` for local test servers).

```sql
CREATE SECRET netlify (TYPE netlify, TOKEN 'nfp_…');
```

`TOKEN` is a redacted secret field. It is read from the secret on every call and never
stored in scan state, so it never travels in HTTP continuation tokens. Pagination uses
only the page number of the `Link: rel="next"` header, never its URL.

**What is never returned:** environment variable values (dropped when the response is
parsed, secret or not), hook and build-hook URLs (reduced to their host), the site
password (only `password_protected`), the site deploy hook, `build_settings.env` values,
`default_hooks_data`, skew-protection tokens and account billing contacts. Form
submission contents (email, name, body, data) are personal data and come back only with
`form_submissions(..., include_contents := true)`.

## Paging and rate limits

Each Netlify page (100 rows) becomes one Arrow batch. The cursor lives in the table
function's serializable state: the phase, the next page number and the pending parent
sites during a fan-out. Long scans therefore resume on any worker process over the HTTP
transport. The worker tracks `X-RateLimit-Remaining` / `-Reset` on every response. A 429
waits for `Retry-After` or the reset (up to 65 s), and the worker pauses on its own when
the bucket is about to run dry. 5xx and network errors retry with exponential backoff.
The worker only issues GET requests.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone --branch v0.1.0 https://github.com/Query-farm/vgi-netlify.git && cd vgi-netlify
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'netlify' (TYPE vgi, LOCATION '/abs/path/to/vgi-netlify/bin/vgi-netlify-worker');
```

**Haybarn 2.0.1+** (`uvx haybarn-cli`; Haybarn 2.0.0 serves an older vgi extension that cannot attach this worker):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'netlify' (TYPE vgi, LOCATION '/abs/path/to/vgi-netlify/bin/vgi-netlify-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed) for Linux, macOS (arm64) and Windows. Point
`LOCATION` at the downloaded binary. The same binary serves HTTP with `--http --port 8000`
(see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (state mapping, pushdown, paging, masking, backoff)
make test-sql                  # test/sql/netlify.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Netlify account. `test/mock_api/server.py` is a
stdlib-only strict replay server. It serves a hand-built account
(`test/fixtures/netlify-account.json`, shaped after the documented OpenAPI responses) plus
250 generated deploys for one site. The server:

- enforces the bearer token;
- rejects any query parameter the endpoint does not document (422);
- pages with `page` / `per_page` and `Link` headers;
- filters deploys by `production`, `state` and `branch`;
- gates the audit log by plan;
- answers one 429 with `Retry-After`.

The SQL tests read its `/__requests` log to check exactly what was pushed down, and they
assert that no secret marker from the fixture ever appears in any row.

The metadata check runs with `execute: false` in CI, because every relation needs a
`netlify` secret for a live account.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
