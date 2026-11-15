#!/usr/bin/env python3
"""An offline Netlify API v1 replay server for the tests (stdlib only).

It serves the hand-built account in ``test/fixtures/netlify-account.json`` (documented
response shapes from https://open-api.netlify.com) plus 250 generated deploys of the
``acme-web`` site, and behaves like Netlify where the worker depends on it:

* **Auth.** ``Authorization: Bearer test-token``; anything else is a 401
  ``{"code": 401, "message": "Access Denied: …"}``.
* **Strict parameters.** Each route accepts only its documented query parameters
  (from the OpenAPI spec); an unknown one, or a malformed ``page`` / ``per_page`` /
  boolean / enum value, is a 422. So the worker cannot send what Netlify would ignore.
* **Paging.** ``page`` (1-based) + ``per_page`` (default 100, max 100) on the paged
  routes, answered with ``Link: <…>; rel="next", <…>; rel="last"``.
* **Deploy filters.** ``production``, ``deploy-previews``, ``state``, ``branch`` and
  ``latest-published`` really filter; deploys are listed newest first.
* **Rate limits.** ``X-RateLimit-Limit/-Remaining/-Reset`` on every response; the first
  ``/api/v1/dns_zones`` request answers 429 (bucket empty, ``Retry-After: 1``) so the
  retry path always runs.
* **Plan gating.** The audit log of an account without it (``grace``) is a 403.
* **Introspection.** ``GET /__requests?path=/api/v1/sites`` returns every recorded
  request to that path (``seq``, ``path``, ``query`` as a JSON object string, ``status``)
  so the SQL tests can assert exactly what was pushed down; ``?prefix=/api/v1/`` matches
  a path prefix instead.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urlparse

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE.parent / "fixtures" / "netlify-account.json").read_text())
TOKEN = "test-token"
BASE = "/api/v1"
MAX_PER_PAGE = 100

LOCK = threading.Lock()
REQUESTS: list[dict] = []
ONCE: set[str] = set()

DEPLOY_STATES = {
    "new", "pending_review", "accepted", "rejected", "enqueued", "building", "uploading", "uploaded",
    "preparing", "prepared", "processing", "processed", "ready", "error", "retrying",
}


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def generate_web_deploys() -> list[dict]:
    """250 acme-web deploys, one every 6 hours back from 2026-11-14T12:00Z, newest first."""
    base = dt.datetime(2026, 11, 14, 12, 0, tzinfo=dt.timezone.utc)
    out = []
    for i in range(250):
        created = base - dt.timedelta(hours=6 * i)
        if i % 4 in (0, 2):
            context, branch = "production", "main"
        elif i % 4 == 1:
            context, branch = "deploy-preview", f"feature-{i % 7}"
        else:
            context, branch = "branch-deploy", "beta"
        d = {
            "id": f"6650{i:020x}",
            "site_id": "site-0001-acme-web",
            "build_id": f"bld-web-{i}",
            "user_id": "usr0ada" if i % 2 == 0 else "usr0grace",
            "name": "acme-web",
            "context": context,
            "branch": branch,
            "commit_ref": f"{i:07x}{'a' * 33}",
            "commit_url": f"https://github.com/acme/web/commit/{i:07x}",
            "title": f"Commit {i}",
            "committer": "Ada" if i % 2 == 0 else "Grace",
            "admin_url": "https://app.netlify.com/sites/acme-web",
            "deploy_url": f"http://6650{i:020x}--acme-web.netlify.app",
            "deploy_ssl_url": f"https://6650{i:020x}--acme-web.netlify.app",
            "created_at": iso(created),
            "manual_deploy": False,
            "draft": False,
            "locked": False,
            "skipped": False,
            "framework": "astro",
            "functions_region": "us-east-2",
            "skew_protection_token": "SKEW_SECRET",
        }
        if context == "deploy-preview":
            d["review_id"] = 100 + i
            d["review_url"] = f"https://github.com/acme/web/pull/{100 + i}"
        if i == 0:
            d.update(state="building", updated_at=iso(created))
        elif i == 1:
            d.update(state="enqueued", updated_at=iso(created))
        elif i == 9:
            d.update(state="ready", skipped=True, updated_at=iso(created + dt.timedelta(seconds=5)))
        else:
            secs = 30 + (i * 7) % 90
            updated = created + dt.timedelta(seconds=secs + 20)
            d.update(deploy_time=secs, updated_at=iso(updated))
            if i % 10 == 3:
                d.update(state="error", error_message="Build script returned non-zero exit code: 2")
            elif i % 25 == 7:
                d.update(state="error", error_message="Canceled build")
            else:
                d["state"] = "ready"
                if context == "production":
                    d["published_at"] = iso(updated)
        out.append(d)
    return out


DEPLOYS = generate_web_deploys() + DATA["deploys"]
_latest_web = next(d for d in DEPLOYS if d["site_id"] == "site-0001-acme-web" and d.get("published_at"))
DATA["sites"][0]["published_deploy"].update(id=_latest_web["id"], published_at=_latest_web["published_at"])
DATA["functions"]["site-0001-acme-web"][0]["id"] = _latest_web["id"]
DATA["builds"]["site-0001-acme-web"] = [
    {"id": d["build_id"], "deploy_id": d["id"], "sha": d["commit_ref"], "done": d["state"] not in ("building", "enqueued"),
     "error": d.get("error_message"), "created_at": d["created_at"]}
    for d in DEPLOYS if d["site_id"] == "site-0001-acme-web"
]
SITES = {s["id"]: s for s in DATA["sites"]}
ACCOUNTS = {a["id"]: a for a in DATA["accounts"]}
SLUGS = {a["slug"]: a for a in DATA["accounts"]}
ZONES = {z["id"]: z for z in DATA["dns_zones"]}
FORMS = {f["id"]: f for fs in DATA["forms"].values() for f in fs}


class ApiError(Exception):
    def __init__(self, status: int, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status, self.message, self.headers = status, message, headers or {}


def site_or_404(site_id: str) -> dict:
    s = SITES.get(site_id)
    if not s:
        raise ApiError(404, "Not Found")
    return s


def boolean(q: dict, name: str) -> bool | None:
    v = q.get(name)
    if v is None:
        return None
    if v not in ("true", "false"):
        raise ApiError(422, f"{name} must be true or false")
    return v == "true"


def paginate(items: list, q: dict, path: str) -> tuple[list, dict]:
    def num(name: str, default: int) -> int:
        v = q.get(name)
        if v is None:
            return default
        if not v.isdigit() or int(v) < 1:
            raise ApiError(422, f"{name} must be a positive integer")
        return int(v)

    page, per_page = num("page", 1), min(num("per_page", MAX_PER_PAGE), MAX_PER_PAGE)
    last = max(1, -(-len(items) // per_page))
    chunk = items[(page - 1) * per_page : page * per_page]
    rest = {k: v for k, v in q.items() if k not in ("page", "per_page")}

    def link(p: int) -> str:
        return f"<https://api.netlify.com{path}?{urlencode({**rest, 'page': p, 'per_page': per_page})}>"

    links = []
    if page < last:
        links.append(f'{link(page + 1)}; rel="next"')
    if page > 1:
        links.append(f'{link(page - 1)}; rel="prev"')
    links.append(f'{link(last)}; rel="last"')
    return chunk, {"Link": ", ".join(links)}


PAGED = ("page", "per_page")


def route(path: str, q: dict) -> tuple[object, dict, tuple]:
    """Return (body, extra headers, allowed params) for a GET under /api/v1."""
    seg = [unquote(s) for s in path[len(BASE):].strip("/").split("/")]
    full = path

    if seg == ["accounts"]:
        return DATA["accounts"], {}, ("minimal",)
    if len(seg) == 2 and seg[0] == "accounts":
        a = ACCOUNTS.get(seg[1]) or SLUGS.get(seg[1])
        if not a:
            raise ApiError(404, "Not Found")
        return a, {}, ()
    if seg == ["sites"]:
        f = q.get("filter")
        if f is not None and f not in ("all", "owner", "guest"):
            raise ApiError(422, "filter must be all, owner or guest")
        items = [s for s in DATA["sites"] if not q.get("name") or q["name"] in s["name"]]
        body, h = paginate(items, q, full)
        return body, h, ("name", "filter") + PAGED
    if len(seg) == 2 and seg[1] == "sites":
        a = SLUGS.get(seg[0])
        if not a:
            raise ApiError(404, "Not Found")
        items = [s for s in DATA["sites"] if s["account_slug"] == a["slug"] and (not q.get("name") or q["name"] in s["name"])]
        body, h = paginate(items, q, full)
        return body, h, ("name",) + PAGED
    if len(seg) == 2 and seg[0] == "sites":
        return site_or_404(seg[1]), {}, ("feature_flags",)
    if len(seg) == 3 and seg[0] == "sites":
        site = site_or_404(seg[1])
        sid, what = site["id"], seg[2]
        if what == "deploys":
            st = q.get("state")
            if st is not None and st not in DEPLOY_STATES:
                raise ApiError(422, f"state must be one of {sorted(DEPLOY_STATES)}")
            prod, previews, latest = boolean(q, "production"), boolean(q, "deploy-previews"), boolean(q, "latest-published")
            items = [
                d for d in DEPLOYS
                if d["site_id"] == sid
                and (prod is None or (d["context"] == "production") == prod)
                and (previews is None or (d["context"] == "deploy-preview") == previews)
                and (st is None or d["state"] == st)
                and (q.get("branch") is None or d.get("branch") == q["branch"])
            ]
            if latest:
                items = [d for d in items if d["id"] == site["published_deploy"]["id"]]
            items.sort(key=lambda d: d["created_at"], reverse=True)
            body, h = paginate(items, q, full)
            return body, h, ("deploy-previews", "production", "state", "branch", "latest-published") + PAGED
        if what == "builds":
            body, h = paginate(DATA["builds"].get(sid, []), q, full)
            return body, h, PAGED
        if what == "forms":
            return DATA["forms"].get(sid, []), {}, ()
        if what == "functions":
            return DATA["functions"].get(sid, []), {}, ("filter",)
        if what == "ssl":
            cert = DATA["ssl"].get(sid)
            if not cert:
                raise ApiError(404, "Not Found")
            return cert, {}, ()
        if what == "build_hooks":
            return DATA["build_hooks"].get(sid, []), {}, ()
        if what == "traffic_splits":
            return DATA["traffic_splits"].get(sid, []), {}, ()
    if len(seg) == 2 and seg[0] == "deploys":
        d = next((d for d in DEPLOYS if d["id"] == seg[1]), None)
        if not d:
            raise ApiError(404, "Not Found")
        return d, {}, ()
    if len(seg) == 3 and seg[1:] == ["builds", "status"]:
        if seg[0] not in DATA["build_status"]:
            raise ApiError(404, "Not Found")
        return DATA["build_status"][seg[0]], {}, ()
    if len(seg) == 3 and seg[0] == "forms" and seg[2] == "submissions":
        if seg[1] not in FORMS:
            raise ApiError(404, "Not Found")
        body, h = paginate(DATA["submissions"].get(seg[1], []), q, full)
        return body, h, PAGED
    if seg == ["dns_zones"]:
        items = [z for z in DATA["dns_zones"] if not q.get("account_slug") or z["account_slug"] == q["account_slug"]]
        return [{**z, "records": DATA["dns_records"].get(z["id"], [])} for z in items], {}, ("account_slug",)
    if len(seg) == 2 and seg[0] == "dns_zones":
        z = ZONES.get(seg[1])
        if not z:
            raise ApiError(404, "Not Found")
        return {**z, "records": DATA["dns_records"].get(z["id"], [])}, {}, ()
    if len(seg) == 3 and seg[0] == "dns_zones" and seg[2] == "dns_records":
        if seg[1] not in ZONES:
            raise ApiError(404, "Not Found")
        return DATA["dns_records"].get(seg[1], []), {}, ()
    if len(seg) == 3 and seg[0] == "accounts" and seg[2] == "env":
        if seg[1] not in ACCOUNTS:
            raise ApiError(404, "Not Found")
        sid = q.get("site_id")
        if sid is not None:
            s = site_or_404(sid)
            if s["account_id"] != seg[1]:
                raise ApiError(404, "Not Found")
            items = DATA["env"].get(sid, [])
        else:
            items = []
        return items, {}, ("context_name", "scope", "site_id")
    if seg == ["hooks"]:
        sid = q.get("site_id")
        if not sid:
            raise ApiError(422, "site_id is required")
        items = [
            h for h in DATA["hooks"]
            if h["site_id"] == sid
            and (q.get("event") is None or h["event"] == q["event"])
            and (q.get("form_id") is None or h.get("form_id") == q["form_id"])
        ]
        return items, {}, ("site_id", "form_id", "event")
    if len(seg) == 2 and seg[1] == "members":
        if seg[0] not in SLUGS:
            raise ApiError(404, "Not Found")
        return DATA["members"].get(seg[0], []), {}, ()
    if len(seg) == 3 and seg[0] == "accounts" and seg[2] == "audit":
        if seg[1] not in ACCOUNTS:
            raise ApiError(404, "Not Found")
        if seg[1] not in DATA["audit"]:
            raise ApiError(403, "Audit log is not available on this plan")
        items = [
            e for e in DATA["audit"][seg[1]]
            if q.get("log_type") is None or e["payload"]["log_type"] == q["log_type"]
        ]
        body, h = paginate(items, q, full)
        return body, h, ("query", "log_type") + PAGED
    raise ApiError(404, "Not Found")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet; stderr only
        sys.stderr.write("mock: " + fmt % args + "\n")

    def send(self, status: int, body: object, headers: dict | None = None) -> None:
        entry = getattr(self, "_entry", None)
        if entry is not None:
            entry["status"] = status
            self._entry = None
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        raw = parse_qs(u.query, keep_blank_values=True)
        q = {k: v[-1] for k, v in raw.items()}
        if u.path == "/__requests":
            want, prefix = q.get("path"), q.get("prefix")
            with LOCK:
                rows = [
                    r for r in REQUESTS
                    if (want is not None and r["path"] == want) or (prefix is not None and r["path"].startswith(prefix))
                ]
            self.send(200, rows)
            return
        if not u.path.startswith(BASE + "/"):
            self.send(404, {"code": 404, "message": "Not Found"})
            return
        entry = {"seq": 0, "path": u.path, "query": json.dumps(q, sort_keys=True), "status": 0}
        with LOCK:
            entry["seq"] = len(REQUESTS) + 1
            REQUESTS.append(entry)
        self._entry = entry
        reset = int(time.time()) + 60
        rl = {"X-RateLimit-Limit": "500", "X-RateLimit-Remaining": "499", "X-RateLimit-Reset": str(reset)}
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send(401, {"code": 401, "message": "Access Denied: Invalid token"}, rl)
            return
        if u.path == f"{BASE}/dns_zones":
            with LOCK:
                first = "dns_zones" not in ONCE
                ONCE.add("dns_zones")
            if first:
                self.send(429, {"code": 429, "message": "Rate limit exceeded"},
                          {**rl, "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(int(time.time()) + 1), "Retry-After": "1"})
                return
        try:
            body, headers, allowed = route(u.path, q)
            unknown = sorted(set(q) - set(allowed))
            if unknown:
                raise ApiError(422, f"unknown query parameter(s): {', '.join(unknown)}")
            self.send(200, body, {**rl, **headers})
        except ApiError as e:
            self.send(e.status, {"code": e.status, "message": e.message}, {**rl, **e.headers})

    def do_POST(self):  # noqa: N802
        self.send(405, {"code": 405, "message": "read-only replay server"})

    do_PUT = do_PATCH = do_DELETE = do_POST


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
