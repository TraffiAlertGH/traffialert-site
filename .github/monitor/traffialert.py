"""TraffiAlert GH monitor (runs from GitHub Actions, no Grok Bot credits).

Checks the public site, APK downloads, the pay server (and keeps it warm), Supabase, routing,
and Premium payments. Fixes what it safely can, keeps one GitHub issue per problem, and emails
the MONITOR_EMAIL address about PAYMENTS only. The repo is public, so the run summary and issues
only say pass/fail: payment counts, amounts and references go in the private email.
"""
from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import socket
import ssl
import time
import urllib.parse

from monitor_lib import (Result, http, http_check, http_json, load_state, now_iso, save_state, send_email,
                         sync_issues, write_summary)

SITE = "https://traffialert.com"
SITE_REPO = "TraffiAlertGH/traffialert-site"
PAY = os.environ.get("PAY_API", "https://traffialert-pay.onrender.com")
ROUTE = "https://routing.openstreetmap.de/routed-car/route/v1/driving/-0.1870,5.6037;-0.1700,5.6100?overview=false"

state = load_state()
emails: list[tuple[str, str]] = []  # (subject, body) - payments only
notes: list[str] = []


def site_pages() -> list[Result]:
    out = []
    for name, path, text in [("Site: home page", "/", "TraffiAlert"), ("Site: privacy page", "/privacy.html", "Privacy"),
                             ("Site: pay page", "/pay.html", "pay.js"), ("Site: admin page", "/admin.html", None)]:
        out.append(http_check(name, SITE + path, contains=text))
    return out


def tls_expiry() -> Result:
    host = "traffialert.com"
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, 443), timeout=10) as sock, ctx.wrap_socket(sock, server_hostname=host) as s:
            cert = s.getpeercert()
        end = dt.datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc)
        days = (end - dt.datetime.now(dt.timezone.utc)).days
        if days < 10:
            return Result("Site: HTTPS certificate", False, f"certificate ends in {days} days")
        return Result("Site: HTTPS certificate", True, f"valid, {days} days left")
    except Exception as e:  # noqa: BLE001
        return Result("Site: HTTPS certificate", False, f"HTTPS check failed ({type(e).__name__})")


def downloads() -> list[Result]:
    out = []
    token = os.environ.get("GITHUB_TOKEN", "")
    status, rel, err = http_json(f"https://api.github.com/repos/{SITE_REPO}/releases/latest",
                                 headers={"Authorization": f"Bearer {token}"} if token else {})
    if status != 200 or not isinstance(rel, dict):
        return [Result("Downloads: latest release", False, f"could not read the latest release ({status or err})")]
    tag = rel.get("tag_name", "?")
    out.append(Result("Downloads: latest release", True, tag))
    for apk in ("TraffiAlertGH-arm64-v8a.apk", "TraffiAlertGH-armeabi-v7a.apk"):
        url = f"https://github.com/{SITE_REPO}/releases/latest/download/{apk}"
        s, _, e = http(url, method="HEAD", timeout=20)
        size = next((a.get("size") for a in rel.get("assets", []) if a.get("name") == apk), 0)
        ok = s == 200 and size > 10_000_000
        out.append(Result(f"Downloads: {apk}", ok, f"{s or e}, {size // 1_000_000} MB" if ok else
                          f"download link answered {s or e}, size {size} bytes"))
    return out


def pay_health() -> Result:
    # The free Render service sleeps; the first call wakes it (about 50 s). Two tries, then redeploy.
    r = Result("Pay server: health", True)
    t0 = time.time()
    status, j, err = http_json(PAY + "/health", timeout=75, retries=0)
    if status != 200:
        time.sleep(5)
        status, j, err = http_json(PAY + "/health", timeout=30, retries=0)
    if status == 200 and isinstance(j, dict) and j.get("ok"):
        mode = j.get("mode", "?")
        r.detail = f"up ({mode} mode, {time.time() - t0:.0f}s)"
        r.warn = mode != "live"
        state["pay_streak"] = 0
        if state.get("pay_down"):
            emails.append(("TraffiAlert payments: pay server is back up", f"The payment server answered again at {now_iso()} UTC."))
            state["pay_down"] = False
        last = state.get("pay_mode")
        if last and last != mode:
            emails.append((f"TraffiAlert payments: now in {mode.upper()} mode",
                           f"The payment server switched from {last} to {mode} mode at {now_iso()} UTC."
                           + (" Real MoMo payments are now being taken." if mode == "live" else "")))
        state["pay_mode"] = mode
        return r
    r.ok = False
    r.detail = f"no healthy answer after two tries ({status or err})"
    state["pay_streak"] = int(state.get("pay_streak", 0)) + 1
    hook = os.environ.get("RENDER_DEPLOY_HOOK", "")
    if hook:
        s, _, e = http(hook, method="POST", timeout=20, retries=0)
        r.fixes.append(f"asked Render to redeploy ({s or e})")
    else:
        r.fixes.append("woke it twice; redeploy hook not set")
    if not state.get("pay_down"):
        emails.append(("TraffiAlert payments: pay server is DOWN",
                       f"The payment server did not answer twice at {now_iso()} UTC. Drivers cannot pay right now.\n"
                       f"Auto-fix: {'; '.join(r.fixes)}. You will get another email when it is back."))
        state["pay_down"] = True
    return r


def supabase() -> Result:
    # The anon key is public (the site ships it in config.js). Read-only call; nothing is printed.
    s, body, e = http(SITE + "/config.js", timeout=20)
    text = body.decode("utf-8", "replace") if s == 200 else ""
    url = re.search(r"supabaseUrl\s*:\s*['\"]([^'\"]+)", text)
    key = re.search(r"supabaseAnonKey\s*:\s*['\"]([^'\"]+)", text)
    if not url or not key:
        return Result("Database: answers", False, f"could not read the public site config ({s or e})")
    k = key.group(1)
    status, j, err = http_json(url.group(1).rstrip("/") + "/rest/v1/rpc/get_premium_status", method="POST", timeout=20,
                               body=json.dumps({"p_install_key": "0" * 64}).encode(),
                               headers={"apikey": k, "Authorization": f"Bearer {k}", "Content-Type": "application/json"})
    if status == 200 and isinstance(j, dict) and j.get("active") is False:
        return Result("Database: answers", True, "read-only Premium check ok")
    return Result("Database: answers", False, f"read-only call answered {status or err}")


def routing() -> Result:
    status, j, err = http_json(ROUTE, timeout=20)
    if status == 200 and isinstance(j, dict) and j.get("code") == "Ok":
        return Result("Directions: routing server", True, "route ok")
    return Result("Directions: routing server", False, f"answered {status or err}")


def payments(pay_ok: bool) -> Result:
    key = os.environ.get("PAY_MONITOR_KEY", "")
    if not key:
        return Result("Payments: new / failed / stuck", True, "skipped (PAY_MONITOR_KEY not set)", warn=True)
    if not pay_ok:
        return Result("Payments: new / failed / stuck", True, "skipped (pay server down)", warn=True)
    started = now_iso()
    since = state.get("pay_since") or (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3, minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ")
    status, j, err = http_json(f"{PAY}/api/pay/monitor?since={urllib.parse.quote(since)}", timeout=40, retries=1,
                               headers={"Authorization": f"Bearer {key}"})
    if status != 200 or not isinstance(j, dict):
        return Result("Payments: new / failed / stuck", False, f"payment summary answered {status or err}")
    state["pay_since"] = started
    live = [p for p in j.get("payments", []) if p.get("live")]
    if live:
        total = sum(float(p.get("amount_ghs", 0)) for p in live)
        lines = [f"- {p.get('plan')} GHS {p.get('amount_ghs'):g} via {p.get('channel')} at {p.get('at')} (ref {p.get('reference')})" for p in live]
        emails.append((f"TraffiAlert payments: {len(live)} new payment(s), GHS {total:g}", "New Premium payments:\n" + "\n".join(lines)))
    failed_live = [p for p in j.get("failed", []) if p.get("live")]
    if failed_live:
        lines = [f"- {p.get('plan')} GHS {p.get('amount_ghs'):g} at {p.get('at')}: {p.get('reason')} (ref {p.get('reference')})" for p in failed_live]
        emails.append((f"TraffiAlert payments: {len(failed_live)} failed payment(s)", "Failed Premium payments (no money taken):\n" + "\n".join(lines)))
    notified = set(state.get("notified", []))
    problems = [p for p in j.get("stuck", []) + j.get("unrecorded", []) if p.get("reference") not in notified]
    bad_live = [p for p in problems if p.get("live")]
    if bad_live:
        lines = [f"- {p.get('reference')} {p.get('plan')} GHS {p.get('amount_ghs'):g}: {p.get('status') or p.get('reason')}" for p in bad_live]
        emails.append(("TraffiAlert payments: payment needs attention",
                       "These payments are stuck or were paid but could not be given a code yet. The monitor retries every run.\n" + "\n".join(lines)))
    state["notified"] = sorted(notified | {p.get("reference") for p in bad_live})[-200:]
    if j.get("unrecorded"):
        # Public issue: no counts, amounts or references (details go in the private email).
        return Result("Payments: new / failed / stuck", False, "some paid payments could not be recorded yet; retrying each run (details emailed)")
    return Result("Payments: new / failed / stuck", True, "checked" + (" (details emailed)" if live or failed_live or bad_live else ""))


def main() -> int:
    results: list[Result] = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        fut_pay = ex.submit(pay_health)
        futs = [ex.submit(f) for f in (site_pages, downloads, tls_expiry, supabase, routing)]
        pay = fut_pay.result()
        fut_payments = ex.submit(payments, pay.ok)
        for f in futs:
            r = f.result()
            results.extend(r if isinstance(r, list) else [r])
        results.append(pay)
        results.append(fut_payments.result())
    actions = sync_issues(results)
    for subject, body in emails:
        # Keep the subject (it can carry amounts) out of the public run summary.
        result = send_email(subject, body)
        notes.append("payment alert emailed" if result.startswith("emailed") else result)
    state["last_run"] = now_iso()
    save_state(state)
    write_summary(results, actions + notes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
