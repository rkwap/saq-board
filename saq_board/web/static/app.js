// SAQ Board: Preact + htm, no build step.
import {
  createContext, html, render, useCallback, useContext, useEffect, useRef, useState,
} from "./vendor/preact-htm.js"

const { root: ROOT, readOnly: READ_ONLY, version: VERSION } = window.SAQ_BOARD

const STATUSES = ["active", "queued", "scheduled", "complete", "failed", "aborted"]
const LABELS = {
  active: "Active", queued: "Queued", scheduled: "Scheduled",
  complete: "Completed", failed: "Failed", aborted: "Aborted", workers: "Workers",
}
const FINISHED = ["complete", "failed", "aborted"]
const DEFAULTS = { poll: 2, pageSize: 20, time: "relative", utc: false, collapsed: false }
const JOB_OPTIONS = ["key", "timeout", "heartbeat", "retries", "ttl", "retry_delay", "retry_backoff",
  "scheduled", "priority", "group_key", "worker_id"]

// ---------------------------------------------------------------- utils

const local = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem("saq-board:" + key)
      return value === null ? fallback : JSON.parse(value)
    } catch { return fallback }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem("saq-board:" + key)
      else localStorage.setItem("saq-board:" + key, JSON.stringify(value))
    } catch { /* storage unavailable */ }
  },
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(ROOT + "/api" + path, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = {}
  try { data = await response.json() } catch { /* not json */ }
  if (!response.ok || data.error) throw new Error(data.error || `${response.status} ${response.statusText}`)
  return data
}

const post = (path, body) => api(path, { method: "POST", body })
const enc = encodeURIComponent
const fmt = n => (n ?? 0).toLocaleString()
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`
const cx = (...names) => names.filter(Boolean).join(" ")
const queuePath = (queue, query = "") => `/queues/${enc(queue)}${query}`
const jobPath = job => `/queues/${enc(job.queue)}/jobs/${enc(job.key)}`
const cronPath = cron => `/cron/${enc(cron.queue)}/${enc(cron.name)}`

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

function relative(ms) {
  const diff = (ms - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return rtf.format(Math.round(diff), "second")
  if (abs < 2700) return rtf.format(Math.round(diff / 60), "minute")
  if (abs < 79200) return rtf.format(Math.round(diff / 3600), "hour")
  return rtf.format(Math.round(diff / 86400), "day")
}

function absolute(ms, utc) {
  const text = new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "medium", timeZone: utc ? "UTC" : undefined,
  })
  return utc ? text + " UTC" : text
}

function duration(ms) {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return Number.isInteger(s) ? `${s}s` : `${s.toFixed(s < 10 ? 2 : 1)}s`
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h < 1) return `${m}m ${Math.round(s % 60)}s`
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const escapeHtml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function highlight(value) {
  const json = JSON.stringify(value, null, 2) ?? "null"
  return escapeHtml(json).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    (match, string, colon, literal) => string
      ? `<span class="${colon ? "key" : "str"}">${string}</span>${colon || ""}`
      : `<span class="${literal ? "lit" : "num"}">${match}</span>`,
  )
}

// SAQ keeps scheduled jobs "queued"; show them as scheduled until they're due.
const jobStatus = job =>
  job.status === "queued" && job.scheduled * 1000 > Date.now() ? "scheduled" : job.status

// ---------------------------------------------------------------- icons (Feather, MIT)

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  retry: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  abort: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  promote: '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  left: '<polyline points="15 18 9 12 15 6"/>',
  right: '<polyline points="9 18 15 12 9 6"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  open: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  expand: '<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>',
  collapse: '<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  key: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
}

const Icon = ({ name }) =>
  html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[name] }} />`

// ---------------------------------------------------------------- app state

const Ctx = createContext()

function parseRoute() {
  let path = location.pathname
  if (ROOT && path.startsWith(ROOT)) path = path.slice(ROOT.length)
  const query = new URLSearchParams(location.search)
  let parts
  try { parts = path.split("/").filter(Boolean).map(decodeURIComponent) } catch { parts = ["?"] }
  const [first, second, third, fourth] = parts
  if (!parts.length) return { name: "overview", query }
  if (first === "queues" && parts.length === 2) return { name: "queue", queue: second, query }
  if (first === "queues" && parts.length === 4 && third === "jobs") return { name: "job", queue: second, job: fourth, query }
  if (first === "cron" && parts.length === 1) return { name: "cron", query }
  if (first === "cron" && parts.length === 3) return { name: "cron-job", queue: second, cron: third, query }
  return { name: "404", query }
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
  local.set("theme", theme === "light" || theme === "dark" ? theme : undefined)
}

const prefersDark = () => matchMedia("(prefers-color-scheme: dark)").matches

function useApi(path) {
  const { tick, setOnline } = useContext(Ctx)
  const [state, setState] = useState({ path, data: null, error: null })

  useEffect(() => {
    if (!path) return undefined
    let live = true
    api(path)
      .then(data => { if (live) { setState({ path, data, error: null }); setOnline(true) } })
      .catch(error => {
        if (!live) return
        setState(s => ({ path, data: s.path === path ? s.data : null, error: error.message }))
        setOnline(false)
      })
    return () => { live = false }
  }, [path, tick])

  // Never show one page's data under another page's path.
  return state.path === path ? state : { path, data: null, error: null }
}

// ---------------------------------------------------------------- building blocks

function Link({ to, children, ...props }) {
  const { navigate } = useContext(Ctx)
  const onClick = event => {
    if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
  return html`<a href=${ROOT + to} onClick=${onClick} ...${props}>${children}</a>`
}

function Time({ ms, prefix }) {
  const { settings } = useContext(Ctx)
  if (!ms) return html`<span class="muted">—</span>`
  const rel = relative(ms)
  const abs = absolute(ms, settings.utc)
  const [shown, other] = settings.time === "relative" ? [rel, abs] : [abs, rel]
  return html`<time datetime=${new Date(ms).toISOString()} title=${other}>${prefix}${shown}</time>`
}

function Button({ icon, children, onClick, kind, small, title, disabled, type = "button" }) {
  const [busy, setBusy] = useState(false)
  const click = async event => {
    if (!onClick) return
    setBusy(true)
    try { await onClick(event) } finally { setBusy(false) }
  }
  const label = typeof children === "string" ? children : undefined
  return html`<button type=${type} disabled=${disabled} aria-busy=${busy ? "true" : undefined}
      class=${cx("btn", kind, small && "small", !children && "icon-only")}
      title=${title || label} aria-label=${title || label} onClick=${click}>
    ${icon && html`<${Icon} name=${icon} />`}${children}
  </button>`
}

const Pill = ({ status, children, dot = true }) =>
  html`<span class=${cx("pill", dot && "dot", "s-" + status)}>${children || LABELS[status] || status}</span>`

const Skeleton = ({ rows = 3 }) =>
  html`<div class="jobs">${Array.from({ length: rows }, (_, i) => html`<div key=${i} class="skeleton" />`)}</div>`

const Empty = ({ icon = "inbox", title, children }) => html`<div class="card empty">
  <span class="empty-icon"><${Icon} name=${icon} /></span><strong>${title}</strong><div>${children}</div>
</div>`

const ErrorCard = ({ error }) => html`<${Empty} icon="alert" title="Something went wrong">${error}<//>`

function Code({ value, error }) {
  if (error) {
    // Tracebacks end with the exception; make that the line that stands out.
    const lines = String(value ?? "").trimEnd().split("\n")
    const last = lines.pop()
    return html`<pre class="code error">${lines.length ? lines.join("\n") + "\n" : ""}<span class="exc">${last}</span></pre>`
  }
  return html`<pre class="code" dangerouslySetInnerHTML=${{ __html: highlight(value) }} />`
}

function Popover({ icon, label, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return undefined
    const close = event => { if (!ref.current?.contains(event.target)) setOpen(false) }
    const escape = event => { if (event.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", escape)
    }
  }, [open])
  return html`<div class="popover-wrap" ref=${ref}>
    <button type="button" class="btn ghost icon-only" title=${label} aria-label=${label}
      aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name=${icon} /></button>
    ${open && html`<div class="popover">${children}</div>`}
  </div>`
}

const Segmented = ({ value, options, onChange }) => html`<div class="segmented">
  ${options.map(([option, label]) => html`<button type="button" key=${option}
    class=${option === value ? "active" : ""} onClick=${() => onChange(option)}>${label}</button>`)}
</div>`

function Modal({ title, onClose, onSubmit, children, footer }) {
  useEffect(() => {
    const escape = event => { if (event.key === "Escape") onClose() }
    document.addEventListener("keydown", escape)
    return () => document.removeEventListener("keydown", escape)
  }, [])
  return html`<div class="modal-backdrop" onMouseDown=${event => event.target === event.currentTarget && onClose()}>
    <form class="card modal" onSubmit=${event => { event.preventDefault(); onSubmit() }}>
      <header><h2>${title}</h2><${Button} icon="x" kind="ghost" small title="Close" onClick=${onClose} /></header>
      <div class="body">${children}</div>
      <footer>${footer}</footer>
    </form>
  </div>`
}

// ---------------------------------------------------------------- chrome

function Sidebar({ queues, route, open }) {
  const [filter, setFilter] = useState("")
  const shown = (queues || []).filter(q => q.name.toLowerCase().includes(filter.toLowerCase()))
  return html`<aside class=${cx("sidebar", open && "open")}>
    <div class="brand">
      <${Link} to="/" class="brand-link"><span class="mark"><${Icon} name="layers" /></span>SAQ Board</${Link}>
      <span class="version">v${VERSION}</span>
    </div>
    <nav class="nav">
      <${Link} to="/" class=${cx("nav-item", route.name === "overview" && "active")}><${Icon} name="grid" />Overview</${Link}>
      <${Link} to="/cron" class=${cx("nav-item", route.name.startsWith("cron") && "active")}><${Icon} name="clock" />Cron jobs</${Link}>
    </nav>
    <div class="nav-label"><span>Queues</span><span class="faint">${queues ? queues.length : ""}</span></div>
    ${queues && queues.length > 5 && html`<div class="sidebar-search">
      <${Icon} name="search" />
      <input placeholder="Filter queues" aria-label="Filter queues" value=${filter} onInput=${e => setFilter(e.target.value)} />
    </div>`}
    <nav class="sidebar-queues">
      ${shown.map(q => html`<${Link} key=${q.name} to=${queuePath(q.name)}
          class=${cx("nav-item", route.queue === q.name && route.name !== "cron-job" && "active")}
          title=${`${q.counts.active} active · ${q.counts.queued} queued · ${q.counts.failed} failed`}>
        <${Icon} name="inbox" /><span class="truncate">${q.name}</span>
        ${q.paused && html`<span class="paused-icon" title="Paused"><${Icon} name="pause" /></span>`}
        ${q.counts.failed > 0 && html`<span class="fail-dot" title=${`${fmt(q.counts.failed)} failed`} />`}
        <span class="count">${fmt(q.counts.active + q.counts.queued)}</span>
      </${Link}>`)}
    </nav>
    <div class="sidebar-footer">
      <a href="https://github.com/rkwap/saq-board" target="_blank" rel="noreferrer"><${Icon} name="github" />GitHub</a>
      <a href="https://saq-py.readthedocs.io" target="_blank" rel="noreferrer"><${Icon} name="book" />SAQ docs</a>
    </div>
  </aside>`
}

function RedisDetails() {
  const { data, error } = useApi("/redis")
  if (error) return html`<p class="form-error">${error}</p>`
  if (!data) return html`<p class="muted">Loading…</p>`
  const r = data.redis
  const rows = [
    ["Version", r.redis_version], ["Mode", r.redis_mode],
    ["Uptime", r.uptime_in_seconds != null ? duration(r.uptime_in_seconds * 1000) : null],
    ["Clients", r.connected_clients], ["Blocked clients", r.blocked_clients],
    ["Memory used", r.used_memory_human], ["Peak memory", r.used_memory_peak_human],
    ["Max memory", r.maxmemory_human], ["Fragmentation", r.mem_fragmentation_ratio],
    ["Ops / sec", r.instantaneous_ops_per_sec],
  ].filter(([, value]) => value != null && value !== "")
  return html`<dl class="props">${rows.map(([k, v]) => html`<dt key=${k}>${k}</dt><dd>${v}</dd>`)}</dl>`
}

function SettingsPanel() {
  const { settings, setSetting, theme, setTheme } = useContext(Ctx)
  return html`
    <label class="field"><span>Refresh</span>
      <select class="input" value=${settings.poll} onChange=${e => setSetting("poll", Number(e.target.value))}>
        ${[[0, "Off"], [1, "Every second"], [2, "Every 2 seconds"], [5, "Every 5 seconds"], [10, "Every 10 seconds"], [30, "Every 30 seconds"]]
          .map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
      </select></label>
    <label class="field"><span>Jobs per page</span>
      <select class="input" value=${settings.pageSize} onChange=${e => setSetting("pageSize", Number(e.target.value))}>
        ${[10, 20, 50, 100].map(v => html`<option key=${v} value=${v}>${v}</option>`)}
      </select></label>
    <div class="field"><span>Theme</span>
      <${Segmented} value=${theme} onChange=${setTheme} options=${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]} /></div>
    <div class="field"><span>Times</span>
      <${Segmented} value=${settings.time} onChange=${v => setSetting("time", v)} options=${[["relative", "Relative"], ["absolute", "Absolute"]]} /></div>
    <div class="field"><span>Time zone</span>
      <${Segmented} value=${settings.utc} onChange=${v => setSetting("utc", v)} options=${[[false, "Local"], [true, "UTC"]]} /></div>
    <div class="field"><span>Job cards</span>
      <${Segmented} value=${settings.collapsed} onChange=${v => setSetting("collapsed", v)} options=${[[false, "Expanded"], [true, "Collapsed"]]} /></div>`
}

function Topbar({ crumbs, onMenu }) {
  const { settings, online, theme, setTheme } = useContext(Ctx)
  const dark = theme === "dark" || (theme === "auto" && prefersDark())
  return html`<header class="topbar">
    <${Button} icon="menu" kind="ghost menu-button" title="Menu" onClick=${onMenu} />
    <div class="crumbs">${crumbs}</div>
    <div class="topbar-actions">
      <span class=${cx("live", !settings.poll && "off", !online && "error")}
        title=${online ? "Connected" : "Can't reach the API"}>
        <span class="dot" /><span>${!online ? "Offline" : settings.poll ? `Live · ${settings.poll}s` : "Paused"}</span>
      </span>
      <${Popover} icon="database" label="Redis"><h3>Redis</h3><${RedisDetails} /></${Popover}>
      <${Popover} icon="sliders" label="Settings"><h3>Settings</h3><${SettingsPanel} /></${Popover}>
      <${Button} icon=${dark ? "sun" : "moon"} kind="ghost" title=${dark ? "Light theme" : "Dark theme"}
        onClick=${() => setTheme(dark ? "light" : "dark")} />
    </div>
  </header>`
}

function Crumbs({ items }) {
  return items.map((item, i) => html`${i > 0 && html`<span class="sep"><${Icon} name="right" /></span>`}${
    item.to ? html`<${Link} to=${item.to} class="truncate">${item.label}</${Link}>` : html`<span class="truncate">${item.label}</span>`
  }`)
}

// ---------------------------------------------------------------- overview

function Overview({ queues, error }) {
  if (error && !queues) return html`<${ErrorCard} error=${error} />`
  if (!queues) return html`<${Skeleton} rows=${2} />`
  const count = key => queues.reduce((n, q) => n + (q.counts[key] || 0), 0)
  const total = key => queues.reduce((n, q) => n + (q.totals[key] || 0), 0)
  const workers = queues.reduce((n, q) => n + Object.keys(q.workers).length, 0)
  const stats = [
    ["Processed", total("complete") + total("failed") + total("aborted"), "complete"],
    ["Failed", total("failed"), "failed"],
    ["Active", count("active"), "active"],
    ["Queued", count("queued"), "queued"],
    ["Scheduled", count("scheduled"), "scheduled"],
    ["Workers", workers, "workers"],
  ]

  return html`
    <div class="page-head"><div>
      <h1>Overview</h1>
      <div class="subtitle">${plural(queues.length, "queue")} · ${plural(workers, "worker")} online</div>
    </div></div>
    <div class="stats">
      ${stats.map(([label, value, status]) => html`<div key=${label} class=${cx("card stat", "s-" + status)}>
        <div class="label">${label}</div><div class="value">${fmt(value)}</div></div>`)}
    </div>
    <div class="section">
      <div class="section-head"><h2>Queues</h2></div>
      ${queues.length ? html`<div class="queue-grid">${queues.map(q => html`<${QueueCard} key=${q.name} queue=${q} />`)}</div>`
        : html`<${Empty} title="No queues">Pass your queues to <code>saq_board(...)</code>, or run workers with <code>with_board()</code>.<//>`}
    </div>`
}

function QueueCard({ queue: q }) {
  const workers = Object.keys(q.workers).length
  return html`<article class="card card-pad queue-card">
    <header>
      <h2 class="truncate"><${Link} to=${queuePath(q.name)}>${q.name}</${Link}></h2>
      ${q.paused && html`<${Pill} status="paused">Paused</${Pill}>`}
      <span class="workers"><${Icon} name="server" />${plural(workers, "worker")}</span>
    </header>
    <div class="bar">${STATUSES.map(s => q.counts[s] ? html`<span key=${s} class=${"s-" + s} style=${{ flex: q.counts[s] }} title=${`${LABELS[s]}: ${fmt(q.counts[s])}`} />` : null)}</div>
    <div class="legend">${STATUSES.map(s => html`<${Link} key=${s} class=${"s-" + s} to=${queuePath(q.name, "?status=" + s)}>${LABELS[s]}<b>${fmt(q.counts[s])}</b></${Link}>`)}</div>
  </article>`
}

// ---------------------------------------------------------------- jobs

function JobCard({ job, standalone, onDuplicate, onRemoved }) {
  const { settings, act } = useContext(Ctx)
  const [open, setOpen] = useState(standalone || !settings.collapsed)
  useEffect(() => setOpen(standalone || !settings.collapsed), [settings.collapsed])

  const status = jobStatus(job)
  const hasResult = job.result != null || job.status === "complete"
  const hasMeta = job.meta && Object.keys(job.meta).length > 0
  const initialTab = job.error && (status === "failed" || status === "aborted") ? "error" : hasResult ? "result" : "kwargs"
  const [tab, setTab] = useState(initialTab)
  useEffect(() => setTab(initialTab), [job.status])

  const run = (action, message, question) => act(message, () => post(jobPath(job) + "/" + action), { confirm: question })
  const options = Object.fromEntries(JOB_OPTIONS.filter(k => job[k] != null && job[k] !== "").map(k => [k, job[k]]))
  const running = job.status === "active" && job.started ? Date.now() - job.started : null
  const took = job.completed && job.started ? job.completed - job.started : running

  const actions = READ_ONLY ? [] : [
    status === "scheduled" && html`<${Button} key="promote" small kind="ghost" icon="promote" title="Run now" onClick=${() => run("promote", "Job promoted")} />`,
    FINISHED.includes(status) && html`<${Button} key="retry" small kind="ghost" icon="retry" title="Retry" onClick=${() => run("retry", "Job retried")} />`,
    ["queued", "scheduled", "active"].includes(status) && html`<${Button} key="abort" small kind="ghost danger" icon="abort" title="Abort"
      onClick=${() => run("abort", "Abort requested", `Abort job ${job.key}?`)} />`,
    onDuplicate && html`<${Button} key="dup" small kind="ghost" icon="copy" title="Duplicate" onClick=${() => onDuplicate(job)} />`,
    FINISHED.includes(status) && html`<${Button} key="remove" small kind="ghost danger" icon="trash" title="Remove"
      onClick=${() => act("Job removed", () => post(jobPath(job) + "/remove"), { confirm: `Remove job ${job.key}?`, then: onRemoved })} />`,
  ]
  const links = [
    !standalone && html`<${Link} key="open" class="btn ghost small icon-only" to=${jobPath(job)} title="Open job" aria-label="Open job"><${Icon} name="open" /></${Link}>`,
    !standalone && html`<${Button} key="toggle" small kind="ghost" icon=${open ? "collapse" : "expand"} title=${open ? "Collapse" : "Expand"} onClick=${() => setOpen(!open)} />`,
  ]
  const toolbar = html`<div class="job-actions" onClick=${e => e.stopPropagation()}>${actions}${links}</div>`
  const key = standalone
    ? html`<span class="key truncate" title=${job.key}><${Icon} name="key" />${job.key}</span>`
    : html`<${Link} to=${jobPath(job)} class="key truncate" title=${job.key} onClick=${e => e.stopPropagation()}><${Icon} name="key" />${job.key}</${Link}>`
  const name = html`<div class="job-name">
    <h3 class="truncate">${job.function}</h3>
    <${Pill} status=${status} />
    ${job.meta?.cron && html`<${Link} class="pill s-scheduled" to=${cronPath({ queue: job.queue, name: job.meta.cron })}><${Icon} name="clock" />cron</${Link}>`}
  </div>`

  if (!open) {
    return html`<article class="card job collapsed">
      <header class="job-head" onClick=${() => setOpen(true)}>
        <div class="job-title">${name}
          <div class="job-meta">${key}<span class="nowrap"><${Time} ms=${job.completed || job.started || job.queued} /></span></div>
        </div>
        ${toolbar}
      </header>
    </article>`
  }

  const finishedLabel = { complete: "Completed", failed: "Failed", aborted: "Aborted" }[job.status] || "Finished"
  const steps = [
    ["Added", job.queued, "s-queued"],
    job.scheduled > 0 && [status === "scheduled" ? "Runs" : "Scheduled for", job.scheduled * 1000, "s-scheduled"],
    ["Started", job.started, "s-active"],
    [finishedLabel, job.completed, "s-" + job.status],
  ].filter(step => step && step[1])

  const tabs = [
    ["kwargs", "Data"],
    hasResult && ["result", "Result"],
    job.error && ["error", "Error"],
    ["options", "Options"],
    hasMeta && ["meta", "Meta"],
  ].filter(Boolean)
  const content = { kwargs: job.kwargs ?? {}, result: job.result, options, meta: job.meta }

  return html`<article class="card job">
    <header class="job-head">
      <div class="job-title">${name}
        <div class="job-meta">
          ${key}
          <span title="Attempts / retries"><${Icon} name="retry" />${job.attempts}/${job.retries} attempts</span>
          ${took != null && html`<span title=${running != null ? "Running for" : "Processing time"}><${Icon} name="clock" />${duration(took)}${running != null ? " so far" : ""}</span>`}
          ${job.timeout ? html`<span>Timeout ${duration(job.timeout * 1000)}</span>` : null}
          ${job.worker_id && html`<span class="truncate" title="Worker"><${Icon} name="server" />${job.worker_id}</span>`}
        </div>
      </div>
      ${toolbar}
    </header>
    <div class="job-body">
      <aside class="job-side">
        <ul class="timeline">${steps.map(([what, ms, cls]) => html`<li key=${what} class=${cls}>
          <span class="what">${what}</span><span class="when"><${Time} ms=${ms} /></span></li>`)}</ul>
      </aside>
      <div class="job-content">
        <div class="job-tabs" role="tablist">${tabs.map(([name, label]) => html`<button type="button" key=${name} role="tab"
          aria-selected=${tab === name} class=${cx(tab === name && "active", name === "error" && "error-tab")}
          onClick=${() => setTab(name)}>${label}</button>`)}</div>
        ${tab === "error" ? html`<${Code} value=${job.error} error />` : html`<${Code} value=${content[tab] ?? content.kwargs} />`}
        ${(job.status === "active" || (job.progress > 0 && job.progress < 1)) &&
          html`<div class="progress" title=${`${Math.round(job.progress * 100)}%`}><span style=${{ width: `${job.progress * 100}%` }} /></div>`}
      </div>
    </div>
  </article>`
}

function AddJob({ queue, functions, initial, onClose }) {
  const { act, navigate } = useContext(Ctx)
  const [fn, setFn] = useState(initial.function || "")
  const [kwargs, setKwargs] = useState(JSON.stringify(initial.kwargs || {}, null, 2))
  const [options, setOptions] = useState(JSON.stringify(initial.options || {}, null, 2))
  const [error, setError] = useState(null)

  const submit = async () => {
    const body = { function: fn.trim() }
    for (const [name, text] of [["kwargs", kwargs], ["options", options]]) {
      try { body[name] = JSON.parse(text || "{}") } catch (e) { return setError(`${name}: ${e.message}`) }
    }
    try {
      const { job } = await post(queuePath(queue, "/jobs"), body)
      onClose()
      act(`Added job ${job.key}`, async () => navigate(jobPath(job)))
    } catch (e) { setError(e.message) }
  }

  return html`<${Modal} title=${`Add job to ${queue}`} onClose=${onClose} onSubmit=${submit}
    footer=${html`<${Button} onClick=${onClose}>Cancel</${Button}><${Button} type="submit" kind="primary" icon="plus">Add job</${Button}>`}>
    <label class="field"><span>Function</span>
      <input class="input mono" list="saq-functions" required value=${fn} onInput=${e => setFn(e.target.value)} placeholder="my_task" autofocus />
      <datalist id="saq-functions">${functions.map(f => html`<option key=${f} value=${f} />`)}</datalist>
      ${functions.length ? null : html`<small>Workers running the plugin publish their function names here.</small>`}
    </label>
    <label class="field"><span>Kwargs</span>
      <textarea class="input" spellcheck="false" value=${kwargs} onInput=${e => setKwargs(e.target.value)} /></label>
    <label class="field"><span>Options</span>
      <textarea class="input" spellcheck="false" value=${options} onInput=${e => setOptions(e.target.value)} />
      <small>Any of key, timeout, heartbeat, retries, ttl, retry_delay, retry_backoff, scheduled (epoch seconds), meta.</small></label>
    ${error && html`<p class="form-error">${error}</p>`}
  </${Modal}>`
}

const duplicateOf = job => ({
  function: job.function,
  kwargs: typeof job.kwargs === "object" ? job.kwargs : {},
  options: Object.fromEntries(["timeout", "heartbeat", "retries", "ttl", "retry_delay", "retry_backoff"]
    .filter(k => job[k]).map(k => [k, job[k]])),
})

function FindJob({ queue }) {
  const { navigate } = useContext(Ctx)
  const [key, setKey] = useState("")
  return html`<form class="search-box" onSubmit=${e => { e.preventDefault(); key.trim() && navigate(`/queues/${enc(queue)}/jobs/${enc(key.trim())}`) }}>
    <${Icon} name="search" />
    <input class="input" placeholder="Find job by key" aria-label="Find job by key" value=${key} onInput=${e => setKey(e.target.value)} />
  </form>`
}

function BulkActions({ queue, status, total }) {
  const { act } = useContext(Ctx)
  if (READ_ONLY || !total) return null
  const bulk = (action, verb, question) => act(r => `${verb} ${plural(r.count, "job")}`,
    () => post(queuePath(queue, "/" + action), { status }), { confirm: question })
  const label = LABELS[status].toLowerCase()
  return html`
    ${status === "scheduled" && html`<${Button} small icon="promote" onClick=${() => bulk("promote-all", "Promoted", `Run all ${total} scheduled jobs now?`)}>Promote all</${Button}>`}
    ${(status === "failed" || status === "aborted") && html`<${Button} small icon="retry" onClick=${() => bulk("retry-all", "Retried", `Retry all ${total} ${label} jobs?`)}>Retry all</${Button}>`}
    ${FINISHED.includes(status) && html`<${Button} small kind="danger" icon="trash" onClick=${() => bulk("clean", "Cleaned", `Remove all ${total} ${label} jobs from the history?`)}>Clean all</${Button}>`}
    ${(status === "queued" || status === "scheduled") && html`<${Button} small kind="danger" icon="abort" onClick=${() => bulk("abort-all", "Aborted", `Abort all ${total} ${label} jobs?`)}>Abort all</${Button}>`}`
}

function Pager({ total, page, pageSize, onPage }) {
  const { settings, setSetting } = useContext(Ctx)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total ? page * pageSize + 1 : 0
  const to = Math.min(total, (page + 1) * pageSize)
  return html`<div class="pager">
    <span>${fmt(from)}–${fmt(to)} of ${fmt(total)}</span>
    <${Button} small icon="left" title="Previous page" disabled=${page <= 0} onClick=${() => onPage(page - 1)} />
    <${Button} small icon="right" title="Next page" disabled=${page >= pages - 1} onClick=${() => onPage(page + 1)} />
    <${Button} small kind="ghost" icon=${settings.collapsed ? "expand" : "collapse"}
      title=${settings.collapsed ? "Expand all" : "Collapse all"} onClick=${() => setSetting("collapsed", !settings.collapsed)} />
  </div>`
}

function Workers({ workers }) {
  const entries = Object.entries(workers)
  if (!entries.length) return html`<${Empty} icon="server" title="No workers online">Workers show up here while they run.<//>`
  return html`<div class="card table-wrap"><table class="table">
    <thead><tr><th>Worker</th><th class="num">Complete</th><th class="num">Failed</th><th class="num">Retried</th>
      <th class="num">Aborted</th><th class="num">Uptime</th><th>Metadata</th></tr></thead>
    <tbody>${entries.map(([id, w]) => {
      const s = w.stats || {}
      return html`<tr key=${id}>
        <td class="mono">${id}</td><td class="num">${fmt(s.complete)}</td><td class="num">${fmt(s.failed)}</td>
        <td class="num">${fmt(s.retried)}</td><td class="num">${fmt(s.aborted)}</td><td class="num nowrap">${duration(s.uptime)}</td>
        <td class="mono muted">${w.metadata ? JSON.stringify(w.metadata) : ""}</td></tr>`
    })}</tbody>
  </table></div>`
}

function QueuePage({ name, query }) {
  const { settings, act, navigate } = useContext(Ctx)
  const status = [...STATUSES, "workers"].includes(query.get("status")) ? query.get("status") : "active"
  const page = Math.max(0, Number(query.get("page")) || 0)
  const pageSize = settings.pageSize
  const [adding, setAdding] = useState(null)
  const detail = useApi(queuePath(name))
  const list = useApi(status === "workers" ? null
    : queuePath(name, `/jobs?status=${status}&offset=${page * pageSize}&limit=${pageSize}`))
  const tabs = useRef()
  const loaded = Boolean(detail.data)

  // Past the last page (after a clean, or a stale link): go to the last page.
  useEffect(() => {
    const data = list.data
    if (data && !data.jobs.length && data.total > 0 && page > 0) {
      const last = Math.ceil(data.total / pageSize) - 1
      navigate(queuePath(name, `?status=${status}${last ? "&page=" + last : ""}`), { replace: true })
    }
  }, [list.data])

  // On narrow screens the tab bar scrolls; keep the current tab in view.
  useEffect(() => {
    const active = tabs.current?.querySelector(".active")
    if (active) tabs.current.scrollLeft = active.offsetLeft - tabs.current.offsetLeft - 16
  }, [status, loaded])

  const q = detail.data?.queue
  if (detail.error && !q) return html`<${ErrorCard} error=${detail.error} />`
  if (!q) return html`<${Skeleton} />`

  const workers = Object.keys(q.workers).length
  const total = list.data?.total ?? q.counts[status] ?? 0
  const go = (s, p = 0) => navigate(queuePath(name, `?status=${s}${p ? "&page=" + p : ""}`))
  const toggle = () => act(q.paused ? "Queue resumed" : "Queue paused",
    () => post(queuePath(name, q.paused ? "/resume" : "/pause")))

  return html`
    <div class="page-head">
      <div>
        <div class="title"><h1>${name}</h1>${q.paused && html`<${Pill} status="paused">Paused</${Pill}>`}</div>
        <div class="subtitle">${[workers ? plural(workers, "worker") + " online" : "No workers online",
          `${fmt(q.totals.complete)} completed`, `${fmt(q.totals.failed)} failed all time`].join(" · ")}</div>
      </div>
      <div class="actions">
        <${FindJob} queue=${name} />
        ${!READ_ONLY && html`
          <${Button} icon=${q.paused ? "play" : "pause"} onClick=${toggle}>${q.paused ? "Resume" : "Pause"}</${Button}>
          <${Button} kind="primary" icon="plus" onClick=${() => setAdding({})}>Add job</${Button}>`}
      </div>
    </div>
    ${workers > 0 && !q.plugin && html`<div class="banner"><${Icon} name="alert" /><div>
      Workers on this queue don't run the saq-board plugin, so finished jobs, pausing and cron jobs aren't tracked.
      Wrap their settings: <code>settings = with_board(settings)</code>.</div></div>`}
    <div class="tabs" role="tablist" ref=${tabs}>
      ${[...STATUSES, "workers"].map(s => html`<${Link} key=${s} role="tab" aria-selected=${s === status}
          class=${cx("tab", "s-" + s, s === status && "active")} to=${queuePath(name, "?status=" + s)}>
        ${LABELS[s]}<span class=${cx("n", s === "failed" && q.counts.failed > 0 && s !== status && "hot")}>${fmt(s === "workers" ? workers : q.counts[s])}</span></${Link}>`)}
    </div>
    ${status === "workers" ? html`<div style="margin-top: 16px"><${Workers} workers=${q.workers} /></div>` : html`
      <div class="toolbar">
        <div class="actions"><${BulkActions} queue=${name} status=${status} total=${total} /></div>
        <${Pager} total=${total} page=${page} pageSize=${pageSize} onPage=${p => go(status, p)} />
      </div>
      ${list.error && !list.data ? html`<${ErrorCard} error=${list.error} />`
        : !list.data ? html`<${Skeleton} />`
        : list.data.jobs.length ? html`<div class="jobs">${list.data.jobs.map(job => html`<${JobCard} key=${job.key}
            job=${job} onDuplicate=${READ_ONLY ? null : j => setAdding(duplicateOf(j))} />`)}</div>`
        : html`<${Empty} title=${`No ${LABELS[status].toLowerCase()} jobs`}>
            ${FINISHED.includes(status) && !q.plugin ? "Finished jobs are recorded by workers running the saq-board plugin." : ""}<//>`}`}
    ${adding && html`<${AddJob} queue=${name} functions=${q.functions || []} initial=${adding} onClose=${() => setAdding(null)} />`}`
}

function JobPage({ queue, jobKey }) {
  const { navigate } = useContext(Ctx)
  const [adding, setAdding] = useState(null)
  const { data, error } = useApi(`/queues/${enc(queue)}/jobs/${enc(jobKey)}`)
  const functions = useApi(adding ? queuePath(queue) : null).data?.queue.functions || []
  if (error && !data) return html`<${ErrorCard} error=${error} />`
  if (!data) return html`<${Skeleton} rows=${1} />`
  return html`
    <div class="page-head"><div>
      <div class="title"><h1 class="truncate">${data.job.function}</h1></div>
      <div class="subtitle mono">${jobKey}</div>
    </div></div>
    <${JobCard} job=${data.job} standalone onDuplicate=${READ_ONLY ? null : j => setAdding(duplicateOf(j))}
      onRemoved=${() => navigate(queuePath(queue, "?status=" + data.job.status))} />
    <div class="section"><div class="section-head"><h2>Raw</h2></div><${Code} value=${data.job} /></div>
    ${adding && html`<${AddJob} queue=${queue} functions=${functions} initial=${adding} onClose=${() => setAdding(null)} />`}`
}

// ---------------------------------------------------------------- cron

function CronActions({ cron, small, onDeleted }) {
  const { act } = useContext(Ctx)
  if (READ_ONLY) return null
  const run = (action, message, question, then) =>
    act(message, () => post(cronPath(cron) + "/" + action), { confirm: question, then })
  return html`
    <${Button} small=${small} icon="zap" kind=${small ? undefined : "primary"} onClick=${() => run("enqueue", `Enqueued ${cron.name}`)}>Enqueue now</${Button}>
    ${cron.enabled
      ? html`<${Button} small=${small} icon="power" onClick=${() => run("disable", `Disabled ${cron.name}`)}>Disable</${Button}>`
      : html`<${Button} small=${small} icon="power" onClick=${() => run("enable", `Enabled ${cron.name}`)}>Enable</${Button}>`}
    ${!cron.enabled && html`<${Button} small=${small} kind="danger" icon="trash"
      onClick=${() => run("delete", `Deleted ${cron.name}`, `Delete cron job ${cron.name}? It comes back when a worker defining it restarts.`, onDeleted)}>Delete</${Button}>`}`
}

const pyRepr = v => v === true ? "True" : v === false ? "False" : v == null ? "None" : JSON.stringify(v)

// cleanup(older_than_days=30) · queue default · retries 3
const cronDefinition = c => [
  `${c.function}(${Object.entries(c.kwargs || {}).map(([k, v]) => `${k}=${pyRepr(v)}`).join(", ")})`,
  `queue ${c.queue}`,
  ...["timeout", "retries", "ttl", "heartbeat"].filter(k => c[k] != null).map(k => `${k} ${c[k]}`),
]

function CronPage() {
  const { act } = useContext(Ctx)
  const [filter, setFilter] = useState("")
  const { data, error } = useApi("/cron")
  if (error && !data) return html`<${ErrorCard} error=${error} />`
  if (!data) return html`<${Skeleton} rows=${2} />`

  const crons = data.cron.filter(c => `${c.name} ${c.function} ${c.queue} ${c.description}`.toLowerCase().includes(filter.toLowerCase()))
  const enabled = data.cron.filter(c => c.enabled).length
  const bulk = (action, verb, question) => act(r => `${verb} ${plural(r.count, "cron job")}`,
    () => post(`/cron/${action}-all`), { confirm: question })

  return html`
    <div class="page-head">
      <div><h1>Cron jobs</h1>
        <div class="subtitle">${plural(data.cron.length, "job")} · ${fmt(enabled)} enabled</div></div>
      <div class="actions">
        ${data.cron.length > 5 && html`<div class="search-box"><${Icon} name="search" />
          <input class="input" placeholder="Filter cron jobs" aria-label="Filter cron jobs" value=${filter} onInput=${e => setFilter(e.target.value)} /></div>`}
        ${!READ_ONLY && data.cron.length > 0 && html`
          <${Button} icon="zap" onClick=${() => bulk("enqueue", "Enqueued", `Enqueue all ${data.cron.length} cron jobs now?`)}>Enqueue all</${Button}>
          <${Button} icon="power" onClick=${() => bulk("enable", "Enabled")}>Enable all</${Button}>
          <${Button} icon="power" onClick=${() => bulk("disable", "Disabled", "Disable all cron jobs?")}>Disable all</${Button}>
          <${Button} kind="danger" icon="trash" onClick=${() => bulk("delete", "Deleted", "Delete all cron jobs? They come back when workers defining them restart.")}>Delete all</${Button}>`}
      </div>
    </div>
    ${data.cron.length ? html`<div class="card table-wrap"><table class="table">
      <thead><tr><th>Status</th><th>Name</th><th>Cron</th><th>Next run</th><th>Last enqueued</th>${!READ_ONLY && html`<th class="num">Actions</th>`}</tr></thead>
      <tbody>${crons.map(c => html`<tr key=${c.queue + c.name} class=${c.enabled ? "" : "disabled"}>
        <td><${Pill} status=${c.enabled ? "enabled" : "disabled"}>${c.enabled ? "Enabled" : "Disabled"}</${Pill}></td>
        <td><${Link} class="cron-name" to=${cronPath(c)}>${c.name}</${Link}>
          ${c.description && html`<div class="cron-desc">${c.description}</div>`}
          <div class="cron-def">${cronDefinition(c).map(part => html`<span key=${part}>${part}</span>`)}</div></td>
        <td><span class="cron-expr">${c.cron}</span><div class="sub">${c.tz}</div></td>
        <td class="nowrap">${c.enabled ? html`<${Time} ms=${c.next_run} />` : html`<span class="muted">—</span>`}</td>
        <td class="nowrap"><${Time} ms=${c.last_enqueued} /></td>
        ${!READ_ONLY && html`<td><div class="row-actions"><${CronActions} cron=${c} small /></div></td>`}
      </tr>`)}</tbody>
    </table></div>` : html`<${Empty} icon="clock" title="No cron jobs yet">
      Define them in your worker settings and wrap the settings with <code>with_board()</code>:
      <pre class="code" style="text-align: left; margin-top: .75rem">"cron_jobs": [CronJob(cleanup, cron="0 * * * *", description="Hourly cleanup")]</pre>
    <//>`}`
}

function CronDetail({ queue, name }) {
  const { navigate } = useContext(Ctx)
  const { data, error } = useApi(`/cron/${enc(queue)}/${enc(name)}`)
  if (error && !data) return html`<${ErrorCard} error=${error} />`
  if (!data) return html`<${Skeleton} rows=${2} />`
  const c = data.cron
  const options = ["timeout", "heartbeat", "retries", "ttl"].filter(k => c[k] != null)

  return html`
    <div class="page-head">
      <div>
        <div class="title"><h1>${c.name}</h1><${Pill} status=${c.enabled ? "enabled" : "disabled"}>${c.enabled ? "Enabled" : "Disabled"}</${Pill}></div>
        ${c.description && html`<div class="subtitle">${c.description}</div>`}
      </div>
      <div class="actions"><${CronActions} cron=${c} onDeleted=${() => navigate("/cron")} /></div>
    </div>
    <div class="grid-2">
      <div class="card card-pad"><dl class="props">
        <dt>Queue</dt><dd><${Link} to=${queuePath(c.queue)}>${c.queue}</${Link}></dd>
        <dt>Function</dt><dd class="mono">${c.function}</dd>
        <dt>Cron</dt><dd><span class="cron-expr">${c.cron}</span> <span class="muted">${c.tz}</span></dd>
        <dt>Next run</dt><dd>${c.enabled ? html`<${Time} ms=${c.next_run} />` : "—"}</dd>
        <dt>Last enqueued</dt><dd><${Time} ms=${c.last_enqueued} /></dd>
        <dt>Last job</dt><dd>${c.last_key ? html`<${Link} class="mono" to=${`/queues/${enc(c.queue)}/jobs/${enc(c.last_key)}`}>${c.last_key}</${Link}>` : "—"}</dd>
        <dt>Unique</dt><dd>${c.unique ? "Yes, skips a run while the previous one is pending" : "No"}</dd>
        ${options.map(k => html`<dt key=${k}>${k[0].toUpperCase() + k.slice(1)}</dt><dd>${c[k]}</dd>`)}
      </dl></div>
      <div class="card card-pad"><h3 style="margin-bottom: 10px">Kwargs</h3><${Code} value=${c.kwargs} /></div>
    </div>
    <div class="section"><div class="section-head"><h2>History</h2></div>
      ${c.history.length ? html`<div class="card table-wrap"><table class="table">
        <thead><tr><th>Enqueued</th><th>Scheduled for</th><th>Trigger</th><th>Job</th></tr></thead>
        <tbody>${c.history.map(h => html`<tr key=${h.key + h.at}>
          <td class="nowrap"><${Time} ms=${h.at} /></td>
          <td class="nowrap"><${Time} ms=${h.run_at} /></td>
          <td><${Pill} status=${h.manual ? "active" : "scheduled"} dot=${false}>${h.manual ? "Manual" : "Schedule"}</${Pill}></td>
          <td>${h.skipped ? html`<span class="muted">Skipped: ${h.skipped}</span>`
            : html`<${Link} class="mono" to=${`/queues/${enc(c.queue)}/jobs/${enc(h.key)}`}>${h.key}</${Link}>`}</td>
        </tr>`)}</tbody>
      </table></div>` : html`<${Empty} icon="clock" title="Not enqueued yet">Runs show up here once the job is enqueued.<//>`}
    </div>`
}

// ---------------------------------------------------------------- app

function App() {
  const [route, setRoute] = useState(parseRoute)
  const [settings, setSettings] = useState(() => ({ ...DEFAULTS, ...local.get("settings", {}) }))
  const [theme, setThemeState] = useState(() => local.get("theme", "auto"))
  const [tick, setTick] = useState(0)
  const [online, setOnline] = useState(true)
  const [toasts, setToasts] = useState([])
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    const onPop = () => setRoute(parseRoute())
    addEventListener("popstate", onPop)
    return () => removeEventListener("popstate", onPop)
  }, [])

  useEffect(() => {
    if (!settings.poll) return undefined
    const id = setInterval(() => { if (!document.hidden) setTick(t => t + 1) }, settings.poll * 1000)
    return () => clearInterval(id)
  }, [settings.poll])

  const navigate = useCallback((to, { replace = false } = {}) => {
    if (replace) history.replaceState(null, "", ROOT + to)
    else history.pushState(null, "", ROOT + to)
    setRoute(parseRoute())
    setMenu(false)
    scrollTo(0, 0)
  }, [])

  const toast = useCallback((message, error = false) => {
    const id = Math.random()
    setToasts(all => [...all.slice(-3), { id, message, error }])
    setTimeout(() => setToasts(all => all.filter(t => t.id !== id)), error ? 7000 : 3000)
  }, [])

  const act = useCallback(async (message, fn, { confirm, then } = {}) => {
    if (confirm && !window.confirm(confirm)) return
    try {
      const result = await fn()
      toast(typeof message === "function" ? message(result) : message)
      if (then) then(result)
    } catch (error) {
      toast(error.message, true)
    }
    setTick(t => t + 1)
  }, [])

  const setSetting = useCallback((key, value) => setSettings(current => {
    const next = { ...current, [key]: value }
    local.set("settings", next)
    return next
  }), [])

  const setTheme = useCallback(value => { applyTheme(value); setThemeState(value) }, [])

  const context = { settings, setSetting, theme, setTheme, tick, online, setOnline, navigate, act, toast }
  return html`<${Ctx.Provider} value=${context}><${Shell} route=${route} menu=${menu} setMenu=${setMenu} />
    <div class="toasts" role="status">${toasts.map(t => html`<div key=${t.id} class=${cx("toast", t.error && "error")}>
      <${Icon} name=${t.error ? "alert" : "check"} /><span>${t.message}</span></div>`)}</div>
  </${Ctx.Provider}>`
}

function Shell({ route, menu, setMenu }) {
  const queues = useApi("/queues")
  let crumbs = [{ label: "Overview" }]
  let page = html`<${Overview} queues=${queues.data?.queues} error=${queues.error} />`
  let title = "Overview"

  if (route.name === "queue") {
    crumbs = [{ label: "Queues", to: "/" }, { label: route.queue }]
    page = html`<${QueuePage} key=${route.queue} name=${route.queue} query=${route.query} />`
    title = route.queue
  } else if (route.name === "job") {
    crumbs = [{ label: route.queue, to: queuePath(route.queue) }, { label: route.job }]
    page = html`<${JobPage} key=${route.queue + "/" + route.job} queue=${route.queue} jobKey=${route.job} />`
    title = `${route.job} · ${route.queue}`
  } else if (route.name === "cron") {
    crumbs = [{ label: "Cron jobs" }]
    page = html`<${CronPage} />`
    title = "Cron jobs"
  } else if (route.name === "cron-job") {
    crumbs = [{ label: "Cron jobs", to: "/cron" }, { label: route.cron }]
    page = html`<${CronDetail} key=${route.queue + "/" + route.cron} queue=${route.queue} name=${route.cron} />`
    title = `${route.cron} · Cron jobs`
  } else if (route.name === "404") {
    crumbs = [{ label: "Not found" }]
    page = html`<${Empty} icon="alert" title="Page not found"><${Link} to="/">Back to the overview</${Link}><//>`
    title = "Not found"
  }

  useEffect(() => { document.title = `${title} · SAQ Board` }, [title])

  return html`<div class="layout">
    <${Sidebar} queues=${queues.data?.queues} route=${route} open=${menu} />
    ${menu && html`<div class="scrim" onClick=${() => setMenu(false)} />`}
    <div class="main">
      <${Topbar} crumbs=${html`<${Crumbs} items=${crumbs} />`} onMenu=${() => setMenu(true)} />
      <main class="content">${page}</main>
    </div>
  </div>`
}

render(html`<${App} />`, document.getElementById("app"))
