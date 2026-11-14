// Admin dashboard logic. Kept out of admin.html so the page can use a strict Content-Security-Policy.
(function () {
  const TZ = "Africa/Accra";
  const SESSION_KEY = "traffialert.admin.session";
  const REFRESH_MS = 45000;
  const gate = document.getElementById("gate");
  const app = document.getElementById("app");
  const denied = document.getElementById("denied");
  const gateMsg = document.getElementById("gate-msg");
  const gateLede = document.getElementById("gate-lede");
  const form = document.getElementById("login-form");
  const loginBtn = document.getElementById("login-btn");
  const emailEl = document.getElementById("email");
  const passwordEl = document.getElementById("password");
  const cfg = window.TRAFFIALERT_ADMIN || {};
  const url = typeof cfg.supabaseUrl === "string" ? cfg.supabaseUrl.replace(/\/$/, "") : "";
  const anon = typeof cfg.supabaseAnonKey === "string" ? cfg.supabaseAnonKey : "";
  const configured = /^https:\/\//.test(url) && anon.length > 20 && !anon.includes("YOUR_PUBLIC_ANON_KEY");
  const payApi = (typeof cfg.payApi === "string" && /^https:\/\//.test(cfg.payApi) ? cfg.payApi : "https://traffialert-pay.onrender.com").replace(/\/$/, "");
  // Set once a session has been accepted by Supabase on this page load; until then the dashboard stays hidden.
  let verified = false;

  const charts = {};
  let refreshTimer = null;

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function scrub(text, secret) {
    let out = String(text || "");
    if (secret && secret.length) out = out.split(secret).join("");
    return out;
  }

  function fmt(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return new Intl.NumberFormat("en-GH").format(n);
  }

  function accraStamp(date) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date) + " Africa/Accra";
  }

  function dayLabel(day) {
    const d = new Date(day + "T12:00:00+00:00");
    return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" }).format(d);
  }

  // The session lives in sessionStorage (this tab only, gone when it closes), not localStorage, so it is
  // not left on the traffialert.com origin where other pages (for example the pay page) also run scripts.
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* clear sessions saved by older versions */ }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }
    catch { return null; }
  }
  function saveSession(session) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* storage blocked */ }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* storage blocked */ }
  }

  async function authFetch(path, body) {
    const res = await fetch(url + path, {
      method: "POST",
      headers: {
        apikey: anon,
        Authorization: "Bearer " + anon,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(function () { return {}; });
    return { ok: res.ok, status: res.status, data: data };
  }

  async function signIn(email, password) {
    const result = await authFetch("/auth/v1/token?grant_type=password", { email: email, password: password });
    if (!result.ok) throw new Error("credentials");
    if (!result.data || !result.data.access_token) throw new Error("credentials");
    return result.data;
  }

  async function refreshSession(session) {
    if (!session || !session.refresh_token) return null;
    const result = await authFetch("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refresh_token });
    if (!result.ok || !result.data || !result.data.access_token) return null;
    saveSession(result.data);
    return result.data;
  }

  async function getStats(session, retried) {
    const res = await fetch(url + "/rest/v1/rpc/get_app_admin_stats", {
      method: "POST",
      headers: {
        apikey: anon,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: "{}"
    });
    if (res.status === 401) {
      // Refresh the token and retry once; a second 401 means the session is no good.
      if (retried) return { kind: "auth" };
      const next = await refreshSession(session);
      if (!next) return { kind: "auth" };
      return getStats(next, true);
    }
    const payload = await res.json().catch(function () { return null; });
    if (!res.ok) {
      const message = payload && (payload.message || payload.error || payload.hint);
      if (res.status === 403 || (typeof message === "string" && /not authorized/i.test(message))) {
        return { kind: "denied" };
      }
      return { kind: "error" };
    }
    return { kind: "ok", data: payload };
  }

  const chartBase = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(12,12,16,0.92)",
        borderColor: "rgba(255,255,255,0.1)",
        borderWidth: 1,
        titleColor: "#f4f4f5",
        bodyColor: "#d4d4d8",
        padding: 10,
        displayColors: false
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: "#8b8b96", maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 11 } },
        border: { display: false }
      },
      y: {
        beginAtZero: true,
        ticks: {
          color: "#8b8b96",
          precision: 0,
          font: { size: 11 },
          callback: function (v) { return Number.isInteger(v) ? v : ""; }
        },
        grid: { color: "rgba(255,255,255,0.05)" },
        border: { display: false }
      }
    }
  };

  function makeLine(id, labels, values, color, fill) {
    const ctx = document.getElementById(id);
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          data: values,
          borderColor: color,
          backgroundColor: fill,
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 3,
          fill: true
        }]
      },
      options: chartBase
    });
  }

  function makeBars(id, labels, values, color) {
    const ctx = document.getElementById(id);
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: color,
          borderRadius: 4,
          borderSkipped: false,
          maxBarThickness: 18
        }]
      },
      options: chartBase
    });
  }

  function setEmpty(id, isEmpty) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", !isEmpty);
  }

  function renderVersions(rows) {
    const root = document.getElementById("versions");
    if (!rows || !rows.length) {
      root.innerHTML = '<p class="blank">No version data yet.</p>';
      return;
    }
    const max = Math.max.apply(null, rows.map(function (r) { return r.count; })) || 1;
    root.innerHTML = rows.map(function (row) {
      const name = String(row.app_version || "unknown");
      const count = Number(row.count) || 0;
      const pct = Math.max(2, Math.round((count / max) * 100));
      return '<div class="ver"><span class="name"></span><div class="bar"><i></i></div><span class="n"></span></div>';
    }).join("");
    Array.prototype.forEach.call(root.querySelectorAll(".ver"), function (el, i) {
      const row = rows[i];
      el.querySelector(".name").textContent = String(row.app_version || "unknown");
      el.querySelector(".n").textContent = fmt(Number(row.count) || 0);
      el.querySelector("i").style.width = Math.max(2, Math.round(((Number(row.count) || 0) / max) * 100)) + "%";
    });
  }

  // The revenue section follows the payment service's own mode instead of a hardcoded "not live" line.
  let payMode = null;
  function setRevenueText(lede, tag, value) {
    document.getElementById("revenue-lede").textContent = lede;
    document.querySelectorAll("[data-rev-tag]").forEach(function (el) { el.textContent = tag; });
    document.querySelectorAll("[data-rev-value]").forEach(function (el) { el.textContent = value; });
    document.getElementById("empty-revenue-text").textContent = tag;
  }
  function renderRevenueMode() {
    if (payMode === "live") {
      setRevenueText("Payments are live on traffialert.com/pay.html. Revenue totals are not connected to this dashboard yet, so no figures are shown here.", "Not connected yet", "—");
    } else if (payMode === "test") {
      setRevenueText("The payment service is in practice (test) mode, so no real money has been taken. Figures stay at GH₵0 until it goes live.", "Practice mode", "GH₵0");
    } else if (payMode === "unknown") {
      setRevenueText("Could not reach the payment service to check whether payments are live. No figures are shown.", "Status unknown", "—");
    } else {
      setRevenueText("Checking the payment service…", "Checking…", "—");
    }
  }
  function loadPayMode() {
    return fetch(payApi + "/healthz", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { payMode = j && (j.mode === "live" || j.mode === "test") ? j.mode : "unknown"; })
      .catch(function () { payMode = "unknown"; })
      .then(renderRevenueMode);
  }

  function renderRevenuePlaceholder() {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, month: "short" }).format(d));
    }
    makeLine("chart-revenue", months, [0, 0, 0, 0, 0, 0], "rgba(252,209,22,0.55)", "rgba(252,209,22,0.08)");
    setEmpty("empty-revenue", true);
    renderRevenueMode();
  }

  function renderStats(data) {
    const installs = Number(data.installs) || 0;
    const online = Number(data.online_now) || 0;
    const today = Number(data.active_today) || 0;
    const week = Number(data.active_7d) || 0;
    document.getElementById("kpi-installs").textContent = fmt(installs);
    document.getElementById("kpi-online").textContent = fmt(online);
    document.getElementById("kpi-today").textContent = fmt(today);
    document.getElementById("kpi-week").textContent = fmt(week);

    const daily = Array.isArray(data.daily) ? data.daily : [];
    const dayLabels = daily.map(function (d) { return dayLabel(d.day); });
    const newVals = daily.map(function (d) { return Number(d.new_installs) || 0; });
    const activeVals = daily.map(function (d) { return Number(d.active) || 0; });
    makeLine("chart-installs", dayLabels, newVals, "#FCD116", "rgba(252,209,22,0.12)");
    makeLine("chart-active", dayLabels, activeVals, "#3dba7a", "rgba(61,186,122,0.12)");
    const hasNew = newVals.some(function (v) { return v > 0; });
    const hasActive = activeVals.some(function (v) { return v > 0; });
    setEmpty("empty-installs", !hasNew);
    setEmpty("empty-active", !hasActive);

    const hourly = Array.isArray(data.hourly) ? data.hourly : [];
    const hourLabels = hourly.map(function (h) {
      const raw = String(h.hour || "");
      return raw.length >= 16 ? raw.slice(11, 16) : raw;
    });
    const hourVals = hourly.map(function (h) { return Number(h.active) || 0; });
    makeBars("chart-hourly", hourLabels, hourVals, "rgba(252,209,22,0.72)");
    setEmpty("empty-hourly", !hourVals.some(function (v) { return v > 0; }));

    renderVersions(Array.isArray(data.by_version) ? data.by_version : []);
    renderRevenuePlaceholder();

    const generated = data.generated_at ? new Date(data.generated_at) : new Date();
    document.getElementById("updated").textContent =
      "Last updated " + accraStamp(generated) + ". This page refreshes while it is open.";
    document.getElementById("live-dot").classList.add("live");
    document.getElementById("live-label").textContent = "Live";
  }

  function sessionEmail(session) {
    if (session && session.user && session.user.email) return session.user.email;
    try {
      const parts = String(session.access_token || "").split(".");
      if (parts.length < 2) return "";
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.email || "";
    } catch { return ""; }
  }

  function setSignedOut() {
    clearSession();
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    hide(app); hide(denied); show(gate);
  }

  function setDenied() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    hide(app); hide(gate); show(denied);
  }

  const GHANA_OUTLINE = [[1.06,5.93],[-0.51,5.34],[-1.06,5.0],[-1.96,4.71],[-2.86,4.99],[-2.81,5.39],[-3.24,6.25],[-2.98,7.38],[-2.56,8.22],[-2.83,9.64],[-2.96,10.4],[-2.94,10.96],[-1.2,11.01],[-0.76,10.94],[-0.44,11.1],[0.02,11.02],[-0.05,10.71],[0.37,10.19],[0.37,9.47],[0.46,8.68],[0.71,8.31],[0.49,7.41],[0.57,6.91],[0.84,6.28],[1.06,5.93]];
  let locData = null;
  let locPeriod = "7d";
  const countryNames = (function () {
    try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch (e) { return null; }
  })();

  function countryName(code) {
    if (!code || code === "??") return "Unknown";
    try { return (countryNames && countryNames.of(code)) || code; } catch (e) { return code; }
  }

  async function getLocations(session) {
    const res = await fetch(url + "/rest/v1/rpc/get_app_admin_locations", {
      method: "POST",
      headers: {
        apikey: anon,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: "{}"
    });
    if (res.status === 404) return { kind: "missing" };
    const payload = await res.json().catch(function () { return null; });
    if (!res.ok) {
      const message = payload && (payload.message || payload.error || payload.hint);
      if (res.status === 401 || res.status === 403 || (typeof message === "string" && /not authorized/i.test(message))) {
        return { kind: "denied" };
      }
      return { kind: "error" };
    }
    return { kind: "ok", data: payload };
  }

  function locTable(rootId, rows, columns, emptyText) {
    const root = document.getElementById(rootId);
    root.textContent = "";
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "blank";
      p.textContent = emptyText;
      root.appendChild(p);
      return;
    }
    const table = document.createElement("table");
    table.className = "loc-table";
    const head = table.createTHead().insertRow();
    ["#"].concat(columns.map(function (c) { return c.label; })).forEach(function (label, i) {
      const th = document.createElement("th");
      th.textContent = i === 0 ? "" : label;
      if (i > 0 && columns[i - 1].num) th.className = "n";
      head.appendChild(th);
    });
    const body = table.createTBody();
    rows.forEach(function (row, index) {
      const tr = body.insertRow();
      const rank = tr.insertCell();
      rank.className = "rank";
      rank.textContent = String(index + 1);
      columns.forEach(function (c) {
        const td = tr.insertCell();
        if (c.num) td.className = "n";
        else if (c.sub) td.className = "sub";
        td.textContent = c.value(row);
      });
    });
    root.appendChild(table);
  }

  function periodRows(rows) {
    const key = "active_" + locPeriod;
    const newKey = "new_" + locPeriod;
    return (Array.isArray(rows) ? rows : [])
      .map(function (r) { return Object.assign({}, r, { _active: Number(r[key]) || 0, _new: Number(r[newKey]) || 0 }); })
      .filter(function (r) { return r._active > 0; })
      .sort(function (a, b) { return b._active - a._active || b._new - a._new; });
  }

  function renderMap(cities) {
    const pts = cities.filter(function (c) { return typeof c.lat === "number" && typeof c.lon === "number"; });
    const max = Math.max.apply(null, pts.map(function (c) { return c._active; }).concat([1]));
    const ctx = document.getElementById("chart-map");
    if (charts["chart-map"]) charts["chart-map"].destroy();
    charts["chart-map"] = new Chart(ctx, {
      type: "bubble",
      data: {
        datasets: [
          {
            type: "line",
            data: GHANA_OUTLINE.map(function (p) { return { x: p[0], y: p[1] }; }),
            borderColor: "rgba(255,255,255,0.28)",
            backgroundColor: "rgba(255,255,255,0.03)",
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0
          },
          {
            data: pts.map(function (c) { return { x: c.lon, y: c.lat, r: 4 + Math.round(18 * Math.sqrt(c._active / max)), label: c.city, n: c._active }; }),
            backgroundColor: "rgba(252,209,22,0.55)",
            borderColor: "#FCD116",
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: Object.assign({}, chartBase.plugins.tooltip, {
            filter: function (item) { return item.datasetIndex === 1; },
            callbacks: {
              label: function (item) { const r = item.raw || {}; return r.label + ": " + fmt(r.n) + " active"; },
              title: function () { return ""; }
            }
          })
        },
        scales: {
          x: { type: "linear", min: -3.6, max: 1.6, display: false },
          y: { type: "linear", min: 4.4, max: 11.4, display: false }
        }
      }
    });
    setEmpty("empty-map", pts.length === 0);
  }

  function renderLocations() {
    const d = locData || {};
    const cities = periodRows(d.cities);
    const regions = periodRows(d.regions).sort(function (a, b) {
      return (a.region === "Not shared yet") - (b.region === "Not shared yet");
    });
    const countries = periodRows(d.countries);
    const cols = function (first) {
      return first.concat([
        { label: "Active", num: true, value: function (r) { return fmt(r._active); } },
        { label: "New", num: true, value: function (r) { return fmt(r._new); } }
      ]);
    };
    locTable("loc-regions", regions, cols([{ label: "Region", value: function (r) { return r.region; } }]), "No regions in this period yet.");
    locTable("loc-cities", cities, cols([
      { label: "Town", value: function (r) { return r.city; } },
      { label: "Region", sub: true, value: function (r) { return r.region || ""; } }
    ]), "No towns in this period yet.");
    locTable("loc-countries", countries, cols([{ label: "Country", value: function (r) { return countryName(r.country); } }]), "No countries in this period yet.");
    renderMap(cities);
    const active = d.active ? Number(d.active[locPeriod]) || 0 : 0;
    const located = d.located ? Number(d.located[locPeriod]) || 0 : 0;
    const withTown = cities.reduce(function (sum, r) { return sum + r._active; }, 0);
    const note = document.getElementById("loc-coverage");
    note.textContent = locData
      ? fmt(active) + " devices active in this period: " + fmt(withTown) + " with a town, " + fmt(Math.max(0, located - withTown)) + " with a country only, " + fmt(Math.max(0, active - located)) + " with no area yet (older app versions share a country only; towns appear from the next app update, when location is allowed). Town list: GeoNames (CC BY 4.0)."
      : "";
  }

  async function loadLocations() {
    const session = loadSession();
    if (!session || !session.access_token) return;
    const result = await getLocations(session).catch(function () { return { kind: "error" }; });
    if (result.kind === "ok") {
      locData = result.data || {};
    } else if (!locData) {
      ["loc-regions", "loc-cities", "loc-countries"].forEach(function (id) {
        const root = document.getElementById(id);
        root.textContent = "";
        const p = document.createElement("p");
        p.className = "blank";
        p.textContent = result.kind === "missing" ? "Location stats are not switched on yet."
          : result.kind === "denied" ? "This account is not allowed to see location stats."
          : "Could not load locations. Try again shortly.";
        root.appendChild(p);
      });
      return;
    }
    renderLocations();
  }

  document.querySelectorAll(".loc-tabs button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      locPeriod = btn.getAttribute("data-period");
      document.querySelectorAll(".loc-tabs button").forEach(function (b) { b.setAttribute("aria-pressed", String(b === btn)); });
      if (locData) renderLocations();
    });
  });

  async function loadDashboard() {
    const session = loadSession();
    if (!session || !session.access_token) { setSignedOut(); return; }
    document.getElementById("who").textContent = sessionEmail(session);
    const result = await getStats(session);
    if (result.kind === "auth") { verified = false; setSignedOut(); gateMsg.className = "msg"; gateMsg.textContent = "Please sign in again."; return; }
    if (result.kind === "denied") { verified = false; setDenied(); return; }
    if (result.kind !== "ok") {
      if (!verified) {
        // The session has not been confirmed yet: keep the dashboard hidden.
        hide(app); hide(denied); show(gate); setGateBusy(false);
        gateMsg.className = "msg";
        gateMsg.textContent = "Could not reach the server to check your sign-in. Try again shortly.";
        return;
      }
      hide(gate); hide(denied); show(app);
      document.getElementById("updated").textContent = "Could not load the dashboard. Try again shortly.";
      document.getElementById("live-dot").classList.remove("live");
      document.getElementById("live-label").textContent = "Paused";
      renderRevenuePlaceholder();
      return;
    }
    const firstLoad = !verified;
    verified = true;
    hide(gate); hide(denied); show(app);
    renderStats(result.data || {});
    loadLocations().catch(function () {});
    if (firstLoad || payMode === null || payMode === "unknown") loadPayMode();
  }

  const CHECKING_TEXT = "Checking your sign-in…";
  function setGateBusy(on) {
    form.querySelectorAll("input, button").forEach(function (el) { el.disabled = on; });
    if (on) { gateMsg.className = "msg info"; gateMsg.textContent = CHECKING_TEXT; }
    else if (gateMsg.textContent === CHECKING_TEXT) { gateMsg.textContent = ""; }
  }

  function armRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      if (document.hidden) return;
      loadDashboard().catch(function () {});
    }, REFRESH_MS);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    gateMsg.textContent = "";
    if (!configured) return;
    loginBtn.disabled = true;
    signIn(email, password)
      .then(function (session) {
        passwordEl.value = "";
        saveSession(session);
        armRefresh();
        return loadDashboard();
      })
      .catch(function (err) {
        passwordEl.value = "";
        const raw = err && err.message ? String(err.message) : "";
        gateMsg.className = "msg";
        if (raw === "credentials") gateMsg.textContent = "Email or password is incorrect.";
        else gateMsg.textContent = scrub("Could not sign in. Try again.", password);
      })
      .then(function () { loginBtn.disabled = false; });
  });

  document.getElementById("signout").addEventListener("click", setSignedOut);
  document.getElementById("denied-out").addEventListener("click", setSignedOut);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadDashboard().catch(function () {});
  });

  if (!configured) {
    form.querySelectorAll("input, button").forEach(function (el) { el.disabled = true; });
    gateLede.textContent = "This page needs a local config.js with the public project URL and anon key. Copy config.example.js to config.js and fill it in. Do not use a service role key.";
    gateMsg.className = "msg info";
    gateMsg.textContent = "Config is not ready yet.";
    return;
  }

  if (typeof Chart !== "undefined") {
    Chart.defaults.font.family = "Sora, system-ui, sans-serif";
    Chart.defaults.color = "#8b8b96";
  }

  if (loadSession()) {
    // Keep the dashboard hidden until Supabase accepts the saved session.
    setGateBusy(true);
    armRefresh();
    loadDashboard()
      .catch(function () {
        if (!verified) { gateMsg.className = "msg"; gateMsg.textContent = "Could not reach the server to check your sign-in. Try again shortly."; }
      })
      .then(function () { setGateBusy(false); });
  }
})();
