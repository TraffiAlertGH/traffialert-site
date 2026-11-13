"""Self-healing monitor helpers. Python standard library only, so it runs on any GitHub runner
with no install step and no credits from anywhere else.

- http(): GET/POST with timeout and one retry
- Result: one check outcome (ok / fail / warn) with a short public-safe detail
- sync_issues(): one GitHub issue per failing check (label "monitor"), updated quietly while it
  stays broken, closed automatically when the check passes again
- send_email(): optional Gmail SMTP alert, only when GMAIL_APP_PASSWORD is set
- load_state()/save_state(): small JSON carried between runs through actions/cache
"""
from __future__ import annotations

import json
import os
import smtplib
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Any

UA = "self-healing-monitor/1.0 (+github actions)"


@dataclass
class Result:
    name: str
    ok: bool
    detail: str = ""
    warn: bool = False  # passed, but worth a line in the summary
    fixes: list[str] = field(default_factory=list)


def http(url: str, *, method: str = "GET", headers: dict[str, str] | None = None, body: bytes | None = None,
         timeout: float = 20, retries: int = 1, retry_wait: float = 5) -> tuple[int, bytes, str]:
    """Returns (status, body, error). status 0 means no answer (DNS, TLS, timeout...)."""
    last_err = ""
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, method=method, headers={"User-Agent": UA, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
                return r.status, r.read(), ""
        except urllib.error.HTTPError as e:
            data = e.read() if hasattr(e, "read") else b""
            if e.code < 500 or attempt == retries:
                return e.code, data, ""
            last_err = f"HTTP {e.code}"
        except Exception as e:  # noqa: BLE001 - any network error is a failed check
            last_err = type(e).__name__ + (f": {e.reason}" if hasattr(e, "reason") else "")
        if attempt < retries:
            time.sleep(retry_wait)
    return 0, b"", last_err or "no answer"


def http_json(url: str, **kw: Any) -> tuple[int, Any, str]:
    status, data, err = http(url, **kw)
    try:
        return status, json.loads(data.decode("utf-8")) if data else None, err
    except ValueError:
        return status, None, err or "not JSON"


# ---------------------------------------------------------------- GitHub

def gh(method: str, path: str, payload: dict | None = None) -> tuple[int, Any]:
    token = os.environ.get("GITHUB_TOKEN", "")
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    body = json.dumps(payload).encode() if payload is not None else None
    status, data, _ = http(api + path, method=method, body=body, timeout=20, retries=1, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"})
    try:
        return status, json.loads(data) if data else None
    except ValueError:
        return status, None


def run_url() -> str:
    s, r, i = (os.environ.get(k, "") for k in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"))
    return f"{s}/{r}/actions/runs/{i}" if i else ""


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sync_issues(results: list[Result], label: str = "monitor") -> list[str]:
    """Open/update one issue per failing check; close it when the check passes. Returns actions taken."""
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo or not os.environ.get("GITHUB_TOKEN"):
        return ["(no GitHub token: issues skipped)"]
    gh("POST", f"/repos/{repo}/labels", {"name": label, "color": "d93f0b", "description": "Opened by the self-healing monitor"})
    status, issues = gh("GET", f"/repos/{repo}/issues?state=open&labels={label}&per_page=100")
    open_by_title = {i["title"]: i for i in (issues or []) if isinstance(i, dict) and "pull_request" not in i} if status == 200 else {}
    done: list[str] = []
    for r in results:
        title = f"[monitor] {r.name}"
        issue = open_by_title.get(title)
        if not r.ok:
            body = (f"**Check:** {r.name}\n\n**Problem:** {r.detail}\n\n"
                    + (f"**Auto-fix tried:** {'; '.join(r.fixes)}\n\n" if r.fixes else "")
                    + f"Last seen failing: {now_iso()} (UTC) - [run]({run_url()})\n\n"
                    "This issue closes by itself when the check passes again.")
            if issue:
                gh("PATCH", f"/repos/{repo}/issues/{issue['number']}", {"body": body})
                done.append(f"updated #{issue['number']} {r.name}")
            else:
                s, new = gh("POST", f"/repos/{repo}/issues", {"title": title, "body": body, "labels": [label]})
                done.append(f"opened #{new.get('number') if isinstance(new, dict) else '?'} {r.name} ({s})")
        elif issue:
            gh("POST", f"/repos/{repo}/issues/{issue['number']}/comments",
               {"body": f"Check passing again at {now_iso()} (UTC) - [run]({run_url()}). Closing."})
            gh("PATCH", f"/repos/{repo}/issues/{issue['number']}", {"state": "closed", "state_reason": "completed"})
            done.append(f"closed #{issue['number']} {r.name}")
    return done


# ---------------------------------------------------------------- email (optional)

def send_email(subject: str, text: str) -> str:
    """Gmail SMTP with an app password. Needs GMAIL_APP_PASSWORD; MAIL_FROM / MAIL_TO default to each other."""
    password = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    sender = os.environ.get("MAIL_FROM", "")
    to = os.environ.get("MAIL_TO", "") or sender
    if not password or not sender:
        return "email skipped (GMAIL_APP_PASSWORD secret not set)"
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, sender, to
    msg.set_content(text + (f"\n\nRun: {run_url()}" if run_url() else ""))
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=20) as s:
            s.login(sender, password)
            s.send_message(msg)
        return f"emailed: {subject}"
    except Exception as e:  # noqa: BLE001
        return f"email failed ({type(e).__name__})"


# ---------------------------------------------------------------- state between runs

STATE_FILE = os.environ.get("MONITOR_STATE", ".monitor-state/state.json")


def load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_FILE) or ".", exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1, sort_keys=True)


def write_summary(results: list[Result], extra: list[str]) -> None:
    lines = ["| Check | Result | Detail |", "|---|---|---|"]
    for r in results:
        mark = "FAIL" if not r.ok else ("ok (note)" if r.warn else "ok")
        detail = (r.detail + (f" - fix: {'; '.join(r.fixes)}" if r.fixes else "")).replace("|", "/")
        lines.append(f"| {r.name} | {mark} | {detail} |")
    text = "\n".join(lines + [""] + [f"- {e}" for e in extra if e]) + "\n"
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write("## Monitor\n\n" + text)


def http_check(name: str, url: str, expect: int = 200, contains: str | None = None, timeout: float = 20) -> Result:
    status, body, err = http(url, timeout=timeout)
    if status != expect:
        return Result(name, False, f"{url} answered {status or err} (expected {expect})")
    if contains and contains.encode() not in body:
        return Result(name, False, f"{url} answered {status} but without the expected text")
    return Result(name, True, f"{status}")
