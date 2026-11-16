# Changelog

## 0.1.2 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.
- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

Initial Netlify worker (from vgi-starter-typescript v1.3.0): read-only catalog tables for accounts, sites, projects, domains, deployments, builds, build stats, forms, functions, DNS zones and records, TLS certificates, env var names, hooks, build hooks, split tests, team members and audit events; deploy(), build_logs() and form_submissions() table functions; netlify.unified.runs.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
