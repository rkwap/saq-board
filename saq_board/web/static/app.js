// SAQ Board: Preact + htm, no build step.
import {
  createContext, html, render, useCallback, useContext, useEffect, useRef, useState,
} from "./vendor/preact-htm.js"

const { root: ROOT, readOnly: READ_ONLY, version: VERSION } = window.SAQ_BOARD

const STATUSES = ["active", "queued", "scheduled", "complete", "failed", "aborted"]
const LABELS = {
  active: "Active", queued: "Queued", scheduled: "Scheduled",
  complete: "Completed", failed: "Failed", aborted: "Aborted", aborting: "Aborting", workers: "Workers",
}
const FINISHED = ["complete", "failed", "aborted"]
const DEFAULTS = { poll: 2, pageSize: 20, time: "relative", utc: false, collapsed: true }
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
const shortKey = key => key.length > 20 ? key.slice(0, 8) + "…" : key

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

// When a job in each tab happened: the column shows the moment that matters for its status.
const TIME_COLUMN = {
  active: "Started", queued: "Added", scheduled: "Runs", complete: "Completed", failed: "Failed", aborted: "Aborted",
}
const jobTime = (job, status) =>
  status === "scheduled" ? job.scheduled * 1000
    : status === "queued" ? job.queued
      : status === "active" ? job.started || job.queued
        : job.completed || job.started || job.queued

// ---------------------------------------------------------------- icons (Hugeicons, MIT)

const ICONS = {
  grid: '<path d="M10.5 8.75V6.75C10.5 5.10626 10.5 4.28439 10.046 3.73121C9.96291 3.62995 9.87005 3.53709 9.76879 3.45398C9.21561 3 8.39374 3 6.75 3C5.10626 3 4.28439 3 3.73121 3.45398C3.62995 3.53709 3.53709 3.62995 3.45398 3.73121C3 4.28439 3 5.10626 3 6.75V8.75C3 10.3937 3 11.2156 3.45398 11.7688C3.53709 11.8701 3.62995 11.9629 3.73121 12.046C4.28439 12.5 5.10626 12.5 6.75 12.5C8.39374 12.5 9.21561 12.5 9.76879 12.046C9.87005 11.9629 9.96291 11.8701 10.046 11.7688C10.5 11.2156 10.5 10.3937 10.5 8.75Z"/><path d="M7.75 15.5H5.75C5.05222 15.5 4.70333 15.5 4.41943 15.5861C3.78023 15.78 3.28002 16.2802 3.08612 16.9194C3 17.2033 3 17.5522 3 18.25C3 18.9478 3 19.2967 3.08612 19.5806C3.28002 20.2198 3.78023 20.72 4.41943 20.9139C4.70333 21 5.05222 21 5.75 21H7.75C8.44778 21 8.79667 21 9.08057 20.9139C9.71977 20.72 10.22 20.2198 10.4139 19.5806C10.5 19.2967 10.5 18.9478 10.5 18.25C10.5 17.5522 10.5 17.2033 10.4139 16.9194C10.22 16.2802 9.71977 15.78 9.08057 15.5861C8.79667 15.5 8.44778 15.5 7.75 15.5Z"/><path d="M21 17.25V15.25C21 13.6063 21 12.7844 20.546 12.2312C20.4629 12.1299 20.3701 12.0371 20.2688 11.954C19.7156 11.5 18.8937 11.5 17.25 11.5C15.6063 11.5 14.7844 11.5 14.2312 11.954C14.1299 12.0371 14.0371 12.1299 13.954 12.2312C13.5 12.7844 13.5 13.6063 13.5 15.25V17.25C13.5 18.8937 13.5 19.7156 13.954 20.2688C14.0371 20.3701 14.1299 20.4629 14.2312 20.546C14.7844 21 15.6063 21 17.25 21C18.8937 21 19.7156 21 20.2688 20.546C20.3701 20.4629 20.4629 20.3701 20.546 20.2688C21 19.7156 21 18.8937 21 17.25Z"/><path d="M18.25 3H16.25C15.5522 3 15.2033 3 14.9194 3.08612C14.2802 3.28002 13.78 3.78023 13.5861 4.41943C13.5 4.70333 13.5 5.05222 13.5 5.75C13.5 6.44778 13.5 6.79667 13.5861 7.08057C13.78 7.71977 14.2802 8.21998 14.9194 8.41388C15.2033 8.5 15.5522 8.5 16.25 8.5H18.25C18.9478 8.5 19.2967 8.5 19.5806 8.41388C20.2198 8.21998 20.72 7.71977 20.9139 7.08057C21 6.79667 21 6.44778 21 5.75C21 5.05222 21 4.70333 20.9139 4.41943C20.72 3.78023 20.2198 3.28002 19.5806 3.08612C19.2967 3 18.9478 3 18.25 3Z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 8V12L14 14"/>',
  layers: '<path d="M8.64298 3.14559L6.93816 3.93362C4.31272 5.14719 3 5.75397 3 6.75C3 7.74603 4.31272 8.35281 6.93817 9.56638L8.64298 10.3544C10.2952 11.1181 11.1214 11.5 12 11.5C12.8786 11.5 13.7048 11.1181 15.357 10.3544L17.0618 9.56638C19.6873 8.35281 21 7.74603 21 6.75C21 5.75397 19.6873 5.14719 17.0618 3.93362L15.357 3.14559C13.7048 2.38186 12.8786 2 12 2C11.1214 2 10.2952 2.38186 8.64298 3.14559Z"/><path d="M20.788 11.0972C20.9293 11.2959 21 11.5031 21 11.7309C21 12.7127 19.6873 13.3109 17.0618 14.5072L15.357 15.284C13.7048 16.0368 12.8786 16.4133 12 16.4133C11.1214 16.4133 10.2952 16.0368 8.64298 15.284L6.93817 14.5072C4.31272 13.3109 3 12.7127 3 11.7309C3 11.5031 3.07067 11.2959 3.212 11.0972"/><path d="M20.3767 16.2661C20.7922 16.5971 21 16.927 21 17.3176C21 18.2995 19.6873 18.8976 17.0618 20.0939L15.357 20.8707C13.7048 21.6236 12.8786 22 12 22C11.1214 22 10.2952 21.6236 8.64298 20.8707L6.93817 20.0939C4.31272 18.8976 3 18.2995 3 17.3176C3 16.927 3.20778 16.5971 3.62334 16.2661"/>',
  inbox: '<path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"/><path d="M21.5 13.5H16.5743C15.7322 13.5 15.0706 14.2036 14.6995 14.9472C14.2963 15.7551 13.4889 16.5 12 16.5C10.5111 16.5 9.70373 15.7551 9.30054 14.9472C8.92942 14.2036 8.26777 13.5 7.42566 13.5H2.5"/>',
  play: '<path d="M18.8906 12.846C18.5371 14.189 16.8667 15.138 13.5257 17.0361C10.296 18.8709 8.6812 19.7884 7.37983 19.4196C6.8418 19.2671 6.35159 18.9776 5.95624 18.5787C5 17.6139 5 15.7426 5 12C5 8.2574 5 6.3861 5.95624 5.42132C6.35159 5.02245 6.8418 4.73288 7.37983 4.58042C8.6812 4.21165 10.296 5.12907 13.5257 6.96393C16.8667 8.86197 18.5371 9.811 18.8906 11.154C19.0365 11.7084 19.0365 12.2916 18.8906 12.846Z"/>',
  pause: '<path d="M4 7C4 5.58579 4 4.87868 4.43934 4.43934C4.87868 4 5.58579 4 7 4C8.41421 4 9.12132 4 9.56066 4.43934C10 4.87868 10 5.58579 10 7V17C10 18.4142 10 19.1213 9.56066 19.5607C9.12132 20 8.41421 20 7 20C5.58579 20 4.87868 20 4.43934 19.5607C4 19.1213 4 18.4142 4 17V7Z"/><path d="M14 7C14 5.58579 14 4.87868 14.4393 4.43934C14.8787 4 15.5858 4 17 4C18.4142 4 19.1213 4 19.5607 4.43934C20 4.87868 20 5.58579 20 7V17C20 18.4142 20 19.1213 19.5607 19.5607C19.1213 20 18.4142 20 17 20C15.5858 20 14.8787 20 14.4393 19.5607C14 19.1213 14 18.4142 14 17V7Z"/>',
  retry: '<path d="M20.5 5.5H9.5C5.78672 5.5 3 8.18503 3 12"/><path d="M3.5 18.5H14.5C18.2133 18.5 21 15.815 21 12"/><path d="M18.5 3C18.5 3 21 4.84122 21 5.50002C21 6.15882 18.5 8 18.5 8"/><path d="M5.49998 16C5.49998 16 3.00001 17.8412 3 18.5C2.99999 19.1588 5.5 21 5.5 21"/>',
  trash: '<path d="M19.5 5.5L18.8803 15.5251C18.7219 18.0864 18.6428 19.3671 18.0008 20.2879C17.6833 20.7431 17.2747 21.1273 16.8007 21.416C15.8421 22 14.559 22 11.9927 22C9.42312 22 8.1383 22 7.17905 21.4149C6.7048 21.1257 6.296 20.7408 5.97868 20.2848C5.33688 19.3626 5.25945 18.0801 5.10461 15.5152L4.5 5.5"/><path d="M3 5.5H21M16.0557 5.5L15.3731 4.09173C14.9196 3.15626 14.6928 2.68852 14.3017 2.39681C14.215 2.3321 14.1231 2.27454 14.027 2.2247C13.5939 2 13.0741 2 12.0345 2C10.9688 2 10.436 2 9.99568 2.23412C9.8981 2.28601 9.80498 2.3459 9.71729 2.41317C9.32164 2.7167 9.10063 3.20155 8.65861 4.17126L8.05292 5.5"/><path d="M9.5 16.5L9.5 10.5"/><path d="M14.5 16.5L14.5 10.5"/>',
  x: '<path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085"/>',
  abort: '<path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"/><path d="M14.9994 15L9 9M9.00064 15L15 9"/>',
  promote: '<path d="M21.8371 12.9178C21.5547 13.6884 20.7014 14.3047 18.9948 15.5372C16.6677 17.218 15.5041 18.0583 14.5312 17.9969C13.7882 17.9499 13.0976 17.6007 12.6223 17.0315C12 16.2863 12 14.8575 12 12C12 9.14246 12 7.71369 12.6223 6.96846C13.0976 6.39933 13.7882 6.0501 14.5312 6.00315C15.5041 5.94167 16.6677 6.78203 18.9948 8.46275C20.7014 9.6953 21.5547 10.3116 21.8371 11.0822C22.0543 11.675 22.0543 12.325 21.8371 12.9178Z"/><path d="M11.8371 12.9178C11.5547 13.6884 10.7014 14.3047 8.99482 15.5372C6.66769 17.218 5.50413 18.0583 4.5312 17.9969C3.78818 17.9499 3.09758 17.6007 2.62232 17.0315C2 16.2863 2 14.8575 2 12C2 9.14246 2 7.71369 2.62232 6.96846C3.09758 6.39933 3.78818 6.0501 4.5312 6.00315C5.50413 5.94167 6.66769 6.78203 8.99482 8.46275C10.7014 9.6953 11.5547 10.3116 11.8371 11.0822C12.0543 11.675 12.0543 12.325 11.8371 12.9178Z"/>',
  copy: '<path d="M7.5 14.5C7.5 11.2002 7.5 9.55025 8.52513 8.52513C9.55025 7.5 11.2002 7.5 14.5 7.5C17.7998 7.5 19.4497 7.5 20.4749 8.52513C21.5 9.55025 21.5 11.2002 21.5 14.5C21.5 17.7998 21.5 19.4497 20.4749 20.4749C19.4497 21.5 17.7998 21.5 14.5 21.5C11.2002 21.5 9.55025 21.5 8.52513 20.4749C7.5 19.4497 7.5 17.7998 7.5 14.5Z"/><path d="M7.5 16.5C6.10355 16.5 5.40533 16.5 4.84402 16.3036C3.83866 15.9518 3.0482 15.1613 2.69641 14.156C2.5 13.5947 2.5 12.8964 2.5 11.5V9.5C2.5 6.20017 2.5 4.55025 3.52513 3.52513C4.55025 2.5 6.20017 2.5 9.5 2.5H11.5C12.8964 2.5 13.5947 2.5 14.156 2.69641C15.1613 3.0482 15.9518 3.83866 16.3036 4.84402C16.5 5.40533 16.5 6.10355 16.5 7.5"/>',
  plus: '<path d="M12.001 5.00003V19.002"/><path d="M19.002 12.002L4.99998 12.002"/>',
  search: '<path d="M17 17L21 21"/><path d="M19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19C15.4183 19 19 15.4183 19 11Z"/>',
  database: '<path d="M3 12C3 7.75736 3 5.63604 4.31802 4.31802C5.63604 3 7.75736 3 12 3C16.2426 3 18.364 3 19.682 4.31802C21 5.63604 21 7.75736 21 12C21 16.2426 21 18.364 19.682 19.682C18.364 21 16.2426 21 12 21C7.75736 21 5.63604 21 4.31802 19.682C3 18.364 3 16.2426 3 12Z"/><path d="M3 12H21"/><path d="M11 7.5L17 7.5"/><path d="M7.125 7.5H7M7.25 7.5C7.25 7.63807 7.13807 7.75 7 7.75C6.86193 7.75 6.75 7.63807 6.75 7.5C6.75 7.36193 6.86193 7.25 7 7.25C7.13807 7.25 7.25 7.36193 7.25 7.5Z"/><path d="M11 16.5L17 16.5"/><path d="M7.125 16.5H7M7.25 16.5C7.25 16.6381 7.13807 16.75 7 16.75C6.86193 16.75 6.75 16.6381 6.75 16.5C6.75 16.3619 6.86193 16.25 7 16.25C7.13807 16.25 7.25 16.3619 7.25 16.5Z"/>',
  sliders: '<path d="M15.5 12C15.5 13.933 13.933 15.5 12 15.5C10.067 15.5 8.5 13.933 8.5 12C8.5 10.067 10.067 8.5 12 8.5C13.933 8.5 15.5 10.067 15.5 12Z"/><path d="M21.011 14.0965C21.5329 13.9558 21.7939 13.8854 21.8969 13.7508C22 13.6163 22 13.3998 22 12.9669V11.0332C22 10.6003 22 10.3838 21.8969 10.2493C21.7938 10.1147 21.5329 10.0443 21.011 9.90358C19.0606 9.37759 17.8399 7.33851 18.3433 5.40087C18.4817 4.86799 18.5509 4.60156 18.4848 4.44529C18.4187 4.28902 18.2291 4.18134 17.8497 3.96596L16.125 2.98673C15.7528 2.77539 15.5667 2.66972 15.3997 2.69222C15.2326 2.71472 15.0442 2.90273 14.6672 3.27873C13.208 4.73448 10.7936 4.73442 9.33434 3.27864C8.95743 2.90263 8.76898 2.71463 8.60193 2.69212C8.43489 2.66962 8.24877 2.77529 7.87653 2.98663L6.15184 3.96587C5.77253 4.18123 5.58287 4.28891 5.51678 4.44515C5.45068 4.6014 5.51987 4.86787 5.65825 5.4008C6.16137 7.3385 4.93972 9.37763 2.98902 9.9036C2.46712 10.0443 2.20617 10.1147 2.10308 10.2492C2 10.3838 2 10.6003 2 11.0332V12.9669C2 13.3998 2 13.6163 2.10308 13.7508C2.20615 13.8854 2.46711 13.9558 2.98902 14.0965C4.9394 14.6225 6.16008 16.6616 5.65672 18.5992C5.51829 19.1321 5.44907 19.3985 5.51516 19.5548C5.58126 19.7111 5.77092 19.8188 6.15025 20.0341L7.87495 21.0134C8.24721 21.2247 8.43334 21.3304 8.6004 21.3079C8.76746 21.2854 8.95588 21.0973 9.33271 20.7213C10.7927 19.2644 13.2088 19.2643 14.6689 20.7212C15.0457 21.0973 15.2341 21.2853 15.4012 21.3078C15.5682 21.3303 15.7544 21.2246 16.1266 21.0133L17.8513 20.034C18.2307 19.8187 18.4204 19.711 18.4864 19.5547C18.5525 19.3984 18.4833 19.132 18.3448 18.5991C17.8412 16.6616 19.0609 14.6226 21.011 14.0965Z"/>',
  sun: '<path d="M17 12C17 14.7614 14.7614 17 12 17C9.23858 17 7 14.7614 7 12C7 9.23858 9.23858 7 12 7C14.7614 7 17 9.23858 17 12Z"/><path d="M12 2V3.5M12 20.5V22M19.0708 19.0713L18.0101 18.0106M5.98926 5.98926L4.9286 4.9286M22 12H20.5M3.5 12H2M19.0713 4.92871L18.0106 5.98937M5.98975 18.0107L4.92909 19.0714"/>',
  moon: '<path d="M21.5 14.0784C20.3003 14.7189 18.9301 15.0821 17.4751 15.0821C12.7491 15.0821 8.91792 11.2509 8.91792 6.52485C8.91792 5.06986 9.28105 3.69968 9.92163 2.5C5.66765 3.49698 2.5 7.31513 2.5 11.8731C2.5 17.1899 6.8101 21.5 12.1269 21.5C16.6849 21.5 20.503 18.3324 21.5 14.0784Z"/>',
  menu: '<path d="M4 5L20 5"/><path d="M4 12L20 12"/><path d="M4 19L20 19"/>',
  zap: '<path d="M5.22576 11.3294L12.224 2.34651C12.7713 1.64397 13.7972 2.08124 13.7972 3.01707V9.96994C13.7972 10.5305 14.1995 10.985 14.6958 10.985H18.0996C18.8729 10.985 19.2851 12.0149 18.7742 12.6706L11.776 21.6535C11.2287 22.356 10.2028 21.9188 10.2028 20.9829V14.0301C10.2028 13.4695 9.80048 13.015 9.3042 13.015H5.90035C5.12711 13.015 4.71494 11.9851 5.22576 11.3294Z"/>',
  power: '<path d="M2.5 12C2.5 7.77027 2.5 5.6554 3.69797 4.25276C3.86808 4.05358 4.05358 3.86808 4.25276 3.69797C5.6554 2.5 7.77027 2.5 12 2.5C16.2297 2.5 18.3446 2.5 19.7472 3.69797C19.9464 3.86808 20.1319 4.05358 20.302 4.25276C21.5 5.6554 21.5 7.77027 21.5 12C21.5 16.2297 21.5 18.3446 20.302 19.7472C20.1319 19.9464 19.9464 20.1319 19.7472 20.302C18.3446 21.5 16.2297 21.5 12 21.5C7.77027 21.5 5.6554 21.5 4.25276 20.302C4.05358 20.1319 3.86808 19.9464 3.69797 19.7472C2.5 18.3446 2.5 16.2297 2.5 12Z"/><circle cx="12" cy="12" r="6"/><path d="M9.875 12H9.75M14.375 12.0014H14.25M10 12C10 12.1381 9.88807 12.25 9.75 12.25C9.61193 12.25 9.5 12.1381 9.5 12C9.5 11.8619 9.61193 11.75 9.75 11.75C9.88807 11.75 10 11.8619 10 12ZM14.5 12.0014C14.5 12.1395 14.3881 12.2514 14.25 12.2514C14.1119 12.2514 14 12.1395 14 12.0014C14 11.8634 14.1119 11.7514 14.25 11.7514C14.3881 11.7514 14.5 11.8634 14.5 12.0014Z"/>',
  server: '<path d="M19 4H5C4.06812 4 3.60218 4 3.23463 4.15224C2.74458 4.35523 2.35523 4.74458 2.15224 5.23463C2 5.60218 2 6.06812 2 7C2 7.93188 2 8.39782 2.15224 8.76537C2.35523 9.25542 2.74458 9.64477 3.23463 9.84776C3.60218 10 4.06812 10 5 10H19C19.9319 10 20.3978 10 20.7654 9.84776C21.2554 9.64477 21.6448 9.25542 21.8478 8.76537C22 8.39782 22 7.93188 22 7C22 6.06812 22 5.60218 21.8478 5.23463C21.6448 4.74458 21.2554 4.35523 20.7654 4.15224C20.3978 4 19.9319 4 19 4Z"/><path d="M19 14H5C4.06812 14 3.60218 14 3.23463 14.1522C2.74458 14.3552 2.35523 14.7446 2.15224 15.2346C2 15.6022 2 16.0681 2 17C2 17.9319 2 18.3978 2.15224 18.7654C2.35523 19.2554 2.74458 19.6448 3.23463 19.8478C3.60218 20 4.06812 20 5 20H19C19.9319 20 20.3978 20 20.7654 19.8478C21.2554 19.6448 21.6448 19.2554 21.8478 18.7654C22 18.3978 22 17.9319 22 17C22 16.0681 22 15.6022 21.8478 15.2346C21.6448 14.7446 21.2554 14.3552 20.7654 14.1522C20.3978 14 19.9319 14 19 14Z"/><path d="M6.125 7H6M6.25 7C6.25 7.13807 6.13807 7.25 6 7.25C5.86193 7.25 5.75 7.13807 5.75 7C5.75 6.86193 5.86193 6.75 6 6.75C6.13807 6.75 6.25 6.86193 6.25 7Z"/><path d="M10.125 7H10M10.25 7C10.25 7.13807 10.1381 7.25 10 7.25C9.86193 7.25 9.75 7.13807 9.75 7C9.75 6.86193 9.86193 6.75 10 6.75C10.1381 6.75 10.25 6.86193 10.25 7Z"/><path d="M6.125 17H6M6.25 17C6.25 17.1381 6.13807 17.25 6 17.25C5.86193 17.25 5.75 17.1381 5.75 17C5.75 16.8619 5.86193 16.75 6 16.75C6.13807 16.75 6.25 16.8619 6.25 17Z"/><path d="M10.125 17H10M10.25 17C10.25 17.1381 10.1381 17.25 10 17.25C9.86193 17.25 9.75 17.1381 9.75 17C9.75 16.8619 9.86193 16.75 10 16.75C10.1381 16.75 10.25 16.8619 10.25 17Z"/>',
  left: '<path d="M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18"/>',
  right: '<path d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18"/>',
  down: '<path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"/>',
  alert: '<path d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z"/><path d="M12 9V13"/><path d="M12.125 16.75H12M12.25 16.75C12.25 16.8881 12.1381 17 12 17C11.8619 17 11.75 16.8881 11.75 16.75C11.75 16.6119 11.8619 16.5 12 16.5C12.1381 16.5 12.25 16.6119 12.25 16.75Z"/>',
  check: '<path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"/><path d="M8 12.5L10.5 15L16 9"/>',
  open: '<path d="M9 6.65032C9 6.65032 15.9383 6.10759 16.9154 7.08463C17.8924 8.06167 17.3496 15 17.3496 15M16.5 7.5L6.5 17.5"/>',
  github: '<path d="M10 20.5675C6.57143 21.7248 3.71429 20.5675 2 17"/><path d="M10 22V18.7579C10 18.1596 10.1839 17.6396 10.4804 17.1699C10.6838 16.8476 10.5445 16.3904 10.1771 16.2894C7.13394 15.4528 5 14.1077 5 9.64606C5 8.48611 5.38005 7.39556 6.04811 6.4464C6.21437 6.21018 6.29749 6.09208 6.31748 5.9851C6.33746 5.87813 6.30272 5.73852 6.23322 5.45932C5.95038 4.32292 5.96871 3.11619 6.39322 2.02823C6.39322 2.02823 7.27042 1.74242 9.26698 2.98969C9.72282 3.27447 9.95075 3.41686 10.1515 3.44871C10.3522 3.48056 10.6206 3.41384 11.1573 3.28041C11.8913 3.09795 12.6476 3 13.5 3C14.3524 3 15.1087 3.09795 15.8427 3.28041C16.3794 3.41384 16.6478 3.48056 16.8485 3.44871C17.0493 3.41686 17.2772 3.27447 17.733 2.98969C19.7296 1.74242 20.6068 2.02823 20.6068 2.02823C21.0313 3.11619 21.0496 4.32292 20.7668 5.45932C20.6973 5.73852 20.6625 5.87813 20.6825 5.9851C20.7025 6.09207 20.7856 6.21019 20.9519 6.4464C21.6199 7.39556 22 8.48611 22 9.64606C22 14.1077 19.8661 15.4528 16.8229 16.2894C16.4555 16.3904 16.3162 16.8476 16.5196 17.1699C16.8161 17.6396 17 18.1596 17 18.7579V22"/>',
  book: '<path d="M15.5 7H8.5M12.499 11H8.49902"/><path d="M20 22H6C4.89543 22 4 21.1046 4 20M4 20C4 18.8954 4.89543 18 6 18H20V6C20 4.11438 20 3.17157 19.4142 2.58579C18.8284 2 17.8856 2 16 2H10C7.17157 2 5.75736 2 4.87868 2.87868C4 3.75736 4 5.17157 4 8V20Z"/><path d="M19.5 18C19.5 18 18.5 18.7628 18.5 20C18.5 21.2372 19.5 22 19.5 22"/>',
  key: '<path d="M15.5 14.5C18.8137 14.5 21.5 11.8137 21.5 8.5C21.5 5.18629 18.8137 2.5 15.5 2.5C12.1863 2.5 9.5 5.18629 9.5 8.5C9.5 9.38041 9.68962 10.2165 10.0303 10.9697L2.5 18.5V21.5H5.5V19.5H7.5V17.5H9.5L13.0303 13.9697C13.7835 14.3104 14.6196 14.5 15.5 14.5Z"/><path d="M17.5 6.5L16.5 7.5"/>',
  more: '<path d="M6.00449 12.5V12M18.0045 12.5V12M12.0045 12.5V12M7.00449 12.5C7.00449 11.9477 6.55677 11.5 6.00449 11.5C5.4522 11.5 5.00449 11.9477 5.00449 12.5C5.00449 13.0523 5.4522 13.5 6.00449 13.5C6.55677 13.5 7.00449 13.0523 7.00449 12.5ZM19.0045 12.5C19.0045 11.9477 18.5568 11.5 18.0045 11.5C17.4522 11.5 17.0045 11.9477 17.0045 12.5C17.0045 13.0523 17.4522 13.5 18.0045 13.5C18.5568 13.5 19.0045 13.0523 19.0045 12.5ZM13.0045 12.5C13.0045 11.9477 12.5568 11.5 12.0045 11.5C11.4522 11.5 11.0045 11.9477 11.0045 12.5C11.0045 13.0523 11.4522 13.5 12.0045 13.5C12.5568 13.5 13.0045 13.0523 13.0045 12.5Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16V12"/><path d="M12.125 8.25H12M12.25 8.25C12.25 8.11193 12.1381 8 12 8C11.8619 8 11.75 8.11193 11.75 8.25C11.75 8.38807 11.8619 8.5 12 8.5C12.1381 8.5 12.25 8.38807 12.25 8.25Z"/>',
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

// Close on a click outside or on Esc.
function useDismiss(open, setOpen) {
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
  return ref
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

function Button({ icon, children, onClick, kind, small, boxed, large, title, disabled, type = "button" }) {
  const [busy, setBusy] = useState(false)
  const click = async event => {
    if (!onClick) return
    setBusy(true)
    try { await onClick(event) } finally { setBusy(false) }
  }
  const label = typeof children === "string" ? children : undefined
  return html`<button type=${type} disabled=${disabled} aria-busy=${busy ? "true" : undefined}
      class=${cx("btn", kind, small && "small", !children && "icon-only", boxed && "boxed", large && "large")}
      title=${title || label} aria-label=${title || label} onClick=${click}>
    ${icon && html`<${Icon} name=${icon} />`}${children}
  </button>`
}

const Tag = ({ status, children }) =>
  html`<span class=${cx("tag", "s-" + status)}>${children || LABELS[status] || status}</span>`

const EnabledBadge = ({ enabled }) => enabled
  ? html`<span class="badge success dot">Enabled</span>`
  : html`<span class="badge dot">Disabled</span>`

const PausedBadge = () => html`<span class="badge warning"><${Icon} name="pause" />Paused</span>`

const Surface = ({ title, actions, flush, children }) => html`<section class=${cx("surface", flush && "flush")}>
  ${title && html`<div class="surface-head"><h2>${title}</h2>${actions}</div>`}${children}
</section>`

const Empty = ({ icon = "inbox", title, children }) => html`<div class="surface"><div class="empty">
  <span class="empty-icon"><${Icon} name=${icon} /></span><strong>${title}</strong>${children && html`<div>${children}</div>`}
</div></div>`

function ErrorBanner({ error }) {
  const { refresh } = useContext(Ctx)
  return html`<div class="banner danger" role="alert"><${Icon} name="abort" />
    <div><strong>We couldn't load this</strong>${error}</div>
    <${Button} small icon="retry" onClick=${refresh}>Try again</${Button}>
  </div>`
}

// Skeleton rows in the shape of a job list, so the page doesn't jump when data arrives.
const Skeleton = ({ rows = 4 }) => html`<div class="surface flush job-list" aria-busy="true" aria-label="Loading">
  ${Array.from({ length: rows }, (_, i) => html`<div key=${i} class="job-row" style="cursor: default">
    <span class="skeleton" style="width: 16px; height: 16px" />
    <span class="skeleton" style=${{ width: `${[48, 36, 42, 32][i % 4]}%`, height: "14px" }} />
    <span class="skeleton attempts" style="width: 32px; height: 14px" />
    <span class="skeleton duration" style="width: 48px; height: 14px; justify-self: end" />
    <span class="skeleton" style="width: 64px; height: 14px; justify-self: end" /><span />
  </div>`)}
</div>`

function Code({ value, error }) {
  if (error) {
    // Tracebacks end with the exception; make that the line that stands out.
    const lines = String(value ?? "").trimEnd().split("\n")
    const last = lines.pop()
    return html`<pre class="code error">${lines.length ? lines.join("\n") + "\n" : ""}<span class="exc">${last}</span></pre>`
  }
  return html`<pre class="code" dangerouslySetInnerHTML=${{ __html: highlight(value) }} />`
}

function CopyButton({ text, label }) {
  const { toast } = useContext(Ctx)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast("Copied to the clipboard")
    } catch {
      toast("Your browser blocked the clipboard. Select the text and copy it instead.", { error: true })
    }
  }
  return html`<${Button} icon="copy" title=${label} onClick=${copy} />`
}

function Popover({ icon, label, children }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, setOpen)
  return html`<div class="popover-wrap" ref=${ref}>
    <button type="button" class="btn icon-only" title=${label} aria-label=${label}
      aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name=${icon} /></button>
    ${open && html`<div class="popover" role="dialog" aria-label=${label}>${children}</div>`}
  </div>`
}

// A "More" button with a list of actions; destructive ones go last.
function Menu({ label, items, large }) {
  const [open, setOpen] = useState(null)
  const ref = useDismiss(open, setOpen)
  // Menus sit in scrolling tables, so place them against the viewport rather than their parent.
  useEffect(() => {
    if (!open) return undefined
    const close = () => setOpen(null)
    addEventListener("scroll", close, true)
    addEventListener("resize", close)
    return () => { removeEventListener("scroll", close, true); removeEventListener("resize", close) }
  }, [open])
  const toggle = event => {
    const rect = event.currentTarget.getBoundingClientRect()
    setOpen(open ? null : { top: rect.bottom + 8, right: innerWidth - rect.right })
  }
  const shown = items.filter(Boolean)
  if (!shown.length) return null
  return html`<div class="popover-wrap" ref=${ref}>
    <button type="button" class=${cx("btn icon-only boxed", large && "large")} title=${label} aria-label=${label}
      aria-haspopup="menu" aria-expanded=${Boolean(open)} onClick=${toggle}><${Icon} name="more" /></button>
    ${open && html`<div class="menu" role="menu" style=${{ position: "fixed", top: open.top, right: open.right }}>
      ${shown.map((item, i) => item === "-" ? html`<hr key=${i} />` : html`<button key=${item.label} type="button" role="menuitem"
        class=${cx(item.risky && "risky")} onClick=${() => { setOpen(false); item.onSelect() }}>
        <${Icon} name=${item.icon} />${item.label}</button>`)}
    </div>`}
  </div>`
}

const Segmented = ({ value, options, onChange, label, small, full }) => html`<div class=${cx("segmented", small && "small", full && "full")}
    role="group" aria-label=${label}>
  ${options.map(([option, text]) => html`<button type="button" key=${String(option)} aria-pressed=${option === value}
    onClick=${() => onChange(option)}>${text}</button>`)}
</div>`

function Dialog({ title, description, onClose, onSubmit, children, footer, small, alert }) {
  const ref = useRef()
  useEffect(() => {
    const escape = event => { if (event.key === "Escape") onClose() }
    document.addEventListener("keydown", escape)
    const opener = document.activeElement
    // Focus the first field; a destructive confirmation starts on Cancel.
    ref.current?.querySelector(alert ? "footer .btn" : "input, textarea, select, footer .btn")?.focus()
    return () => {
      document.removeEventListener("keydown", escape)
      opener?.focus?.()
    }
  }, [])
  return html`<div class="modal-backdrop" onMouseDown=${event => event.target === event.currentTarget && onClose()}>
    <form class=${cx("dialog", small && "small")} ref=${ref} role=${alert ? "alertdialog" : "dialog"} aria-modal="true"
      aria-label=${title} onSubmit=${event => { event.preventDefault(); onSubmit() }}>
      <header><div><h2>${title}</h2>${description && html`<p class="description">${description}</p>`}</div>
        <${Button} icon="x" title="Close" onClick=${onClose} /></header>
      ${children && html`<div class="body">${children}</div>`}
      <footer>${footer}</footer>
    </form>
  </div>`
}

function ConfirmDialog({ title, body, label, danger = true, onAnswer }) {
  return html`<${Dialog} small alert=${danger} title=${title} description=${body}
    onClose=${() => onAnswer(false)} onSubmit=${() => onAnswer(true)}
    footer=${html`<${Button} onClick=${() => onAnswer(false)}>Cancel</${Button}>
      <button type="submit" class=${cx("btn", danger ? "danger" : "primary")}>${label}</button>`} />`
}

// ---------------------------------------------------------------- chrome

function Sidebar({ queues, route, open }) {
  const [filter, setFilter] = useState("")
  const shown = (queues || []).filter(q => q.name.toLowerCase().includes(filter.toLowerCase()))
  const current = on => on ? "page" : undefined
  return html`<aside class=${cx("sidebar", open && "open")}>
    <div class="brand">
      <${Link} to="/" class="brand-link"><span class="mark"><${Icon} name="layers" /></span>SAQ Board</${Link}>
      <span class="version">v${VERSION}</span>
    </div>
    <nav class="nav" aria-label="Main">
      <${Link} to="/" class="nav-item" aria-current=${current(route.name === "overview")}><${Icon} name="grid" /><span class="label">Overview</span></${Link}>
      <${Link} to="/cron" class="nav-item" aria-current=${current(route.name.startsWith("cron"))}><${Icon} name="clock" /><span class="label">Cron jobs</span></${Link}>
    </nav>
    <nav class="nav" aria-label="Queues">
      <div class="nav-label"><span>Queues</span><span>${queues ? queues.length : ""}</span></div>
      ${queues && queues.length > 5 && html`<div class="sidebar-search">
        <${Icon} name="search" />
        <input class="input" placeholder="Filter queues" aria-label="Filter queues" value=${filter} onInput=${e => setFilter(e.target.value)} />
      </div>`}
      ${shown.map(q => html`<${Link} key=${q.name} to=${queuePath(q.name)} class="nav-item"
          aria-current=${current((route.name === "queue" || route.name === "job") && route.queue === q.name)}
          title=${`${fmt(q.counts.active)} active · ${fmt(q.counts.queued)} queued · ${fmt(q.counts.failed)} failed`}>
        <${Icon} name="inbox" /><span class="label">${q.name}</span>
        <span class="count">
          ${q.paused && html`<span class="paused-icon" title="Paused"><${Icon} name="pause" /></span>`}
          ${q.counts.failed > 0 && html`<span class="fail-dot" title=${`${fmt(q.counts.failed)} failed`} />`}
          ${fmt(q.counts.active + q.counts.queued)}
        </span>
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
  return html`<dl class="facts large">${rows.map(([k, v]) => html`<dt key=${k}>${k}</dt><dd class="tabular">${v}</dd>`)}</dl>`
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
      <${Segmented} full label="Theme" value=${theme} onChange=${setTheme} options=${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]} /></div>
    <div class="field"><span>Times</span>
      <${Segmented} full label="Times" value=${settings.time} onChange=${v => setSetting("time", v)} options=${[["relative", "Relative"], ["absolute", "Absolute"]]} /></div>
    <div class="field"><span>Time zone</span>
      <${Segmented} full label="Time zone" value=${settings.utc} onChange=${v => setSetting("utc", v)} options=${[[false, "Local"], [true, "UTC"]]} /></div>
    <div class="field"><span>Job rows</span>
      <${Segmented} full label="Job rows" value=${settings.collapsed} onChange=${v => setSetting("collapsed", v)} options=${[[true, "Compact"], [false, "Expanded"]]} /></div>`
}

function Topbar({ crumbs, onMenu }) {
  const { settings, online, theme, setTheme } = useContext(Ctx)
  const dark = theme === "dark" || (theme === "auto" && prefersDark())
  return html`<header class="topbar">
    <${Button} icon="menu" kind="menu-button" title="Menu" onClick=${onMenu} />
    <${Link} to="/" class="topbar-brand"><span class="mark"><${Icon} name="layers" /></span>SAQ Board</${Link}>
    <nav class="crumbs" aria-label="Breadcrumbs">${crumbs}</nav>
    <div class="topbar-actions">
      <span class=${cx("live", !settings.poll && "off", !online && "error")}
        title=${online ? "Connected" : "Can't reach the API"}>
        <span class="dot" /><span>${!online ? "Offline" : settings.poll ? `Live · ${settings.poll}s` : "Refresh off"}</span>
      </span>
      ${READ_ONLY && html`<span class="badge outline" style="margin-right: 8px">Read-only</span>`}
      <${Popover} icon="database" label="Redis"><h3>Redis</h3><${RedisDetails} /></${Popover}>
      <${Popover} icon="sliders" label="Settings"><h3>Settings</h3><${SettingsPanel} /></${Popover}>
      <${Button} icon=${dark ? "sun" : "moon"} title=${dark ? "Light theme" : "Dark theme"}
        onClick=${() => setTheme(dark ? "light" : "dark")} />
    </div>
  </header>`
}

function Crumbs({ items }) {
  return items.map((item, i) => html`${i > 0 && html`<span class="sep"><${Icon} name="right" /></span>`}${
    item.to ? html`<${Link} to=${item.to} class="truncate">${item.label}</${Link}>`
      : html`<span class="truncate" aria-current="page">${item.label}</span>`
  }`)
}

const PageHead = ({ title, badge, meta = [], actions }) => html`<div class="page-head">
  <div>
    <div class="title"><h1 class="truncate">${title}</h1>${badge}</div>
    ${meta.length > 0 && html`<div class="subtitle dots">${meta.filter(Boolean).map((m, i) => html`<span key=${i}>${m}</span>`)}</div>`}
  </div>
  ${actions && html`<div class="actions">${actions}</div>`}
</div>`

// ---------------------------------------------------------------- overview

function Overview({ queues, error }) {
  if (error && !queues) return html`<${ErrorBanner} error=${error} />`
  if (!queues) return html`<${Skeleton} rows=${2} />`
  const count = key => queues.reduce((n, q) => n + (q.counts[key] || 0), 0)
  const total = key => queues.reduce((n, q) => n + (q.totals[key] || 0), 0)
  const workers = queues.reduce((n, q) => n + Object.keys(q.workers).length, 0)
  const stats = [
    ["Processed", total("complete") + total("failed") + total("aborted")],
    ["Failed", total("failed"), "failed"],
    ["Active", count("active"), "active"],
    ["Queued", count("queued"), "queued"],
    ["Scheduled", count("scheduled"), "scheduled"],
    ["Workers", workers],
  ]

  return html`
    <${PageHead} title="Overview" meta=${[plural(queues.length, "queue"), `${plural(workers, "worker")} online`]} />
    <section class="surface flush" aria-label="Totals"><div class="stats">
      ${stats.map(([label, value, status]) => html`<div key=${label} class="stat">
        <div class="label">${status && html`<span class=${"swatch s-" + status} />`}${label}</div>
        <div class="value">${fmt(value)}</div></div>`)}
    </div></section>
    ${queues.length ? html`<${Surface} flush title="Queues"><div class="table-wrap"><table class="table">
      <thead><tr><th>Queue</th><th>Jobs</th>
        ${STATUSES.map(s => html`<th key=${s} class="num"><span class="th-swatch"><span class=${"swatch s-" + s} />${LABELS[s]}</span></th>`)}
        <th class="num">Workers</th></tr></thead>
      <tbody>${queues.map(q => html`<${QueueRow} key=${q.name} queue=${q} />`)}</tbody>
    </table></div></${Surface}>`
      : html`<${Empty} title="No queues">Pass your queues to <code>saq_board(...)</code>, or run workers with <code>with_board()</code>.<//>`}`
}

function QueueRow({ queue: q }) {
  // History keeps only the newest completions, so count them from the running total.
  const counts = { ...q.counts, complete: q.totals.complete }
  return html`<tr>
    <td><div class="queue-name"><${Link} class="name-link" to=${queuePath(q.name)}>${q.name}</${Link}>${q.paused && html`<${PausedBadge} />`}</div></td>
    <td style="width: 22%"><div class="bar">${STATUSES.map(s => counts[s] ? html`<span key=${s} class=${"s-" + s}
      style=${{ flex: counts[s] }} title=${`${LABELS[s]}: ${fmt(counts[s])}`} />` : null)}</div></td>
    ${STATUSES.map(s => html`<td key=${s} class=${cx("num", !counts[s] && "zero", s === "failed" && counts[s] > 0 && "bad")}>
      <${Link} to=${queuePath(q.name, "?status=" + s)} style="color: inherit">${fmt(counts[s])}</${Link}></td>`)}
    <td class="num">${fmt(Object.keys(q.workers).length)}</td>
  </tr>`
}

// ---------------------------------------------------------------- jobs

// What you can do to a job, in the order they're shown; risky ones confirm first.
function jobActions(job, { act, onDuplicate, onRemoved }) {
  if (READ_ONLY) return []
  const status = jobStatus(job)
  const key = shortKey(job.key)
  const run = (action, message, confirm) => act(message, () => post(jobPath(job) + "/" + action), { confirm })
  return [
    status === "scheduled" && { name: "promote", label: "Run now", icon: "promote", main: true, onClick: () => run("promote", "Job promoted") },
    FINISHED.includes(status) && { name: "retry", label: "Retry", icon: "retry", main: true, onClick: () => run("retry", "Job retried") },
    onDuplicate && { name: "duplicate", label: "Duplicate", icon: "copy", onClick: () => onDuplicate(job) },
    ["queued", "scheduled", "active", "aborting"].includes(status) && {
      name: "abort", label: "Abort", icon: "abort", risky: true,
      onClick: () => run("abort", "Abort requested", {
        title: `Abort job ${key}?`, body: "It stops and moves to Aborted.", label: "Abort job",
      }),
    },
    FINISHED.includes(status) && {
      name: "remove", label: "Remove", icon: "trash", risky: true,
      onClick: () => act("Job removed", () => post(jobPath(job) + "/remove"), {
        confirm: { title: `Remove job ${key}?`, body: `It's removed from the history of ${job.queue}. You can't undo this.`, label: "Remove job" },
        then: onRemoved,
      }),
    },
  ].filter(Boolean)
}

const jobTabs = job => {
  const hasResult = job.result != null || job.status === "complete"
  return [
    job.error && ["error", "Error"],
    hasResult && ["result", "Result"],
    ["kwargs", "Data"],
    ["options", "Options"],
    job.meta && Object.keys(job.meta).length > 0 && ["meta", "Meta"],
  ].filter(Boolean)
}

const jobOptions = job => Object.fromEntries(JOB_OPTIONS.filter(k => job[k] != null && job[k] !== "").map(k => [k, job[k]]))

function runtime(job) {
  if (job.status === "active" && job.started) return { ms: Date.now() - job.started, running: true }
  if (job.completed && job.started) return { ms: job.completed - job.started, running: false }
  return null
}

function Timeline({ job }) {
  const status = jobStatus(job)
  const took = runtime(job)
  const finished = {
    complete: ["Completed", took && ` in ${duration(took.ms)}`, "check"],
    failed: ["Failed", took && ` after ${duration(took.ms)}`, "abort"],
    aborted: ["Aborted", "", "abort"],
  }[job.status]
  const steps = [
    ["added", "plus", html`<b>Added</b> to ${job.queue}`, job.queued],
    job.scheduled > 0 && ["scheduled", "clock", html`<b>${status === "scheduled" ? "Runs" : "Scheduled"}</b>`, job.scheduled * 1000],
    ["started", "play", html`<b>Started</b>${job.worker_id ? ` on worker ${shortKey(job.worker_id)}` : ""}`, job.started],
    finished && ["finished", finished[2], html`<b>${finished[0]}</b>${finished[1]}`, job.completed, "s-" + job.status],
  ].filter(step => step && step[3])
  return html`<ol class="timeline">${steps.map(([key, icon, what, ms, marked]) => html`<li key=${key}>
    <span class=${cx("disc", marked && "marked " + marked)}><${Icon} name=${icon} /></span>
    <div class="what">${what}<${Time} ms=${ms} /></div>
  </li>`)}</ol>`
}

const Progress = ({ value }) =>
  html`<div class="progress" title=${`${Math.round(value * 100)}%`}><span style=${{ width: `${value * 100}%` }} /></div>`

function JobRow({ job, status: listed, onDuplicate }) {
  const { settings, act } = useContext(Ctx)
  const [open, setOpen] = useState(!settings.collapsed)
  useEffect(() => setOpen(!settings.collapsed), [settings.collapsed])

  const status = jobStatus(job)
  const tabs = jobTabs(job)
  const [tab, setTab] = useState(tabs[0][0])
  useEffect(() => setTab(jobTabs(job)[0][0]), [job.status])
  const took = runtime(job)
  const actions = jobActions(job, { act, onDuplicate })
  const content = { error: job.error, kwargs: job.kwargs ?? {}, result: job.result, options: jobOptions(job), meta: job.meta }
  const stop = event => event.stopPropagation()

  return html`<article class=${cx("job", open && "open")}>
    <div class="job-row" onClick=${() => setOpen(!open)}>
      <button type="button" class="chev btn icon-only" style="width: 20px; height: 20px" aria-expanded=${open}
        aria-label=${open ? "Collapse" : "Expand"} onClick=${e => { stop(e); setOpen(!open) }}><${Icon} name=${open ? "down" : "right"} /></button>
      <div class="job-name">
        <span class="fn">${job.function}</span>
        ${status !== listed && html`<${Tag} status=${status} />`}
        ${job.meta?.cron && html`<${Link} class="tag s-scheduled" to=${cronPath({ queue: job.queue, name: job.meta.cron })} onClick=${stop}>cron</${Link}>`}
        <${Link} to=${jobPath(job)} class="key truncate" title=${job.key} onClick=${stop}>${job.key}</${Link}>
      </div>
      <span class="attempts tabular" title="Attempts / retries">${job.attempts}/${job.retries}</span>
      <span class="duration timing">
        ${job.status === "active" && job.progress > 0 && html`<${Progress} value=${job.progress} />`}
        <span class="tabular" title=${took?.running ? "Running for" : "Processing time"}>${took ? duration(took.ms) : ""}</span>
      </span>
      <span class="end"><${Time} ms=${jobTime(job, status)} /></span>
      <div class="job-actions" onClick=${stop}>
        ${actions.map(a => html`<${Button} key=${a.name} kind=${a.risky && "risky"} icon=${a.icon} title=${a.label} onClick=${a.onClick} />`)}
      </div>
    </div>
    ${open && html`<div class="job-detail">
      <aside>
        <${Timeline} job=${job} />
        <dl class="facts">
          ${job.timeout ? html`<dt>Timeout</dt><dd>${duration(job.timeout * 1000)}</dd>` : null}
          <dt>Retries</dt><dd class="tabular">${job.retries}</dd>
          ${job.worker_id && html`<dt>Worker</dt><dd class="mono truncate" title=${job.worker_id}>${job.worker_id}</dd>`}
        </dl>
      </aside>
      <div>
        <div class="toolbar">
          <div class="segmented small" role="tablist" aria-label="Job details">${tabs.map(([name, label]) => html`<button type="button"
            key=${name} role="tab" aria-selected=${tab === name} class=${cx(name === "error" && "error-tab")}
            onClick=${() => setTab(name)}>${label}</button>`)}</div>
          <${Link} class="btn ghost small" to=${jobPath(job)}>Open job<${Icon} name="open" /></${Link}>
        </div>
        ${tab === "error" ? html`<${Code} value=${job.error} error />` : html`<${Code} value=${content[tab] ?? content.kwargs} />`}
        ${job.status === "active" && job.progress > 0 && html`<${Progress} value=${job.progress} />`}
      </div>
    </div>`}
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
    for (const [name, label, text] of [["kwargs", "Kwargs", kwargs], ["options", "Options", options]]) {
      try { body[name] = JSON.parse(text || "{}") } catch (e) {
        return setError({ field: name, message: `${label} isn't valid JSON: ${e.message}` })
      }
    }
    try {
      const { job } = await post(queuePath(queue, "/jobs"), body)
      onClose()
      act(`Added job ${shortKey(job.key)}`, async () => navigate(jobPath(job)))
    } catch (e) { setError({ message: e.message }) }
  }

  const fieldError = name => error?.field === name && html`<span class="field-error"><${Icon} name="alert" />${error.message}</span>`
  return html`<${Dialog} title=${`Add a job to ${queue}`} description="It runs as soon as a worker picks it up, unless you schedule it."
    onClose=${onClose} onSubmit=${submit}
    footer=${html`<${Button} onClick=${onClose}>Cancel</${Button}><${Button} type="submit" kind="primary" icon="plus">Add job</${Button}>`}>
    <label class="field"><span>Function</span>
      <input class="input mono" list="saq-functions" required value=${fn} onInput=${e => setFn(e.target.value)} placeholder="e.g. send_email" />
      <datalist id="saq-functions">${functions.map(f => html`<option key=${f} value=${f} />`)}</datalist>
      <small>${functions.length ? "Suggestions come from the functions your workers register." : "Workers running the plugin publish their function names here."}</small>
    </label>
    <label class="field"><span>Kwargs</span>
      <textarea class=${cx("input", error?.field === "kwargs" && "invalid")} spellcheck="false" value=${kwargs} onInput=${e => setKwargs(e.target.value)} />
      ${fieldError("kwargs")}</label>
    <label class="field"><span>Options</span>
      <textarea class=${cx("input", error?.field === "options" && "invalid")} spellcheck="false" value=${options} onInput=${e => setOptions(e.target.value)} />
      ${fieldError("options") || html`<small>Any of key, timeout, heartbeat, retries, ttl, retry_delay, retry_backoff, scheduled (epoch seconds), meta.</small>`}</label>
    ${error && !error.field && html`<p class="form-error">${error.message}</p>`}
  </${Dialog}>`
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
  const input = useRef()
  // "/" jumps to the search field from anywhere on the page.
  useEffect(() => {
    const onKey = event => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.target.closest?.("input, textarea, select, [contenteditable]")) return
      event.preventDefault()
      input.current?.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])
  return html`<form class="search-box" role="search" onSubmit=${e => { e.preventDefault(); key.trim() && navigate(`/queues/${enc(queue)}/jobs/${enc(key.trim())}`) }}>
    <${Icon} name="search" />
    <input class="input" ref=${input} placeholder="Find job by key" aria-label="Find job by key" value=${key} onInput=${e => setKey(e.target.value)} />
    <kbd class="kbd">/</kbd>
  </form>`
}

function BulkActions({ queue, status, total }) {
  const { act } = useContext(Ctx)
  if (READ_ONLY || !total) return null
  const bulk = (action, verb, confirm) => act(r => `${verb} ${plural(r.count, "job")}`,
    () => post(queuePath(queue, "/" + action), { status }), { confirm })
  const label = LABELS[status].toLowerCase()
  const n = fmt(total)
  return html`
    ${status === "scheduled" && html`<${Button} small icon="promote" onClick=${() => bulk("promote-all", "Promoted", {
      title: `Run all ${n} scheduled jobs now?`, body: "They skip their scheduled time and run as soon as a worker is free.",
      label: `Run ${plural(total, "job")}`, danger: false })}>Run all now</${Button}>`}
    ${(status === "failed" || status === "aborted") && html`<${Button} small icon="retry" onClick=${() => bulk("retry-all", "Retried", {
      title: `Retry all ${n} ${label} jobs?`, body: "Each one goes back on the queue with its original data.",
      label: `Retry ${plural(total, "job")}`, danger: false })}>Retry all</${Button}>`}
    ${FINISHED.includes(status) && html`<${Button} small kind="risky" icon="trash" onClick=${() => bulk("clean", "Cleaned", {
      title: `Clean all ${n} ${label} jobs?`, body: `They're removed from the history of ${queue}. You can't undo this.`,
      label: `Clean ${plural(total, "job")}` })}>Clean all</${Button}>`}
    ${(status === "queued" || status === "scheduled") && html`<${Button} small kind="risky" icon="abort" onClick=${() => bulk("abort-all", "Aborted", {
      title: `Abort all ${n} ${label} jobs?`, body: "They move to Aborted and won't run.",
      label: `Abort ${plural(total, "job")}` })}>Abort all</${Button}>`}`
}

function Pager({ total, page, pageSize, onPage }) {
  const { settings, setSetting } = useContext(Ctx)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total ? page * pageSize + 1 : 0
  const to = Math.min(total, (page + 1) * pageSize)
  return html`<div class="pager">
    <span>${fmt(from)}–${fmt(to)} of ${fmt(total)}</span>
    <${Button} boxed icon="left" title="Previous page" disabled=${page <= 0} onClick=${() => onPage(page - 1)} />
    <${Button} boxed icon="right" title="Next page" disabled=${page >= pages - 1} onClick=${() => onPage(page + 1)} />
    <span style="width: 4px" />
    <${Segmented} small label="Job rows" value=${settings.collapsed} onChange=${v => setSetting("collapsed", v)}
      options=${[[true, "Compact"], [false, "Expanded"]]} />
  </div>`
}

function Workers({ workers }) {
  const entries = Object.entries(workers)
  if (!entries.length) return html`<${Empty} icon="server" title="No workers online">Workers show up here while they run.<//>`
  return html`<div class="surface flush table-wrap"><table class="table">
    <thead><tr><th>Worker</th><th class="num">Complete</th><th class="num">Failed</th><th class="num">Retried</th>
      <th class="num">Aborted</th><th class="num">Uptime</th><th>Metadata</th></tr></thead>
    <tbody>${entries.map(([id, w]) => {
      const s = w.stats || {}
      return html`<tr key=${id}>
        <td class="mono">${id}</td><td class="num">${fmt(s.complete)}</td><td class=${cx("num", s.failed > 0 && "bad")}>${fmt(s.failed)}</td>
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
  if (detail.error && !q) return html`<${ErrorBanner} error=${detail.error} />`
  if (!q) return html`<${Skeleton} />`

  const workers = Object.keys(q.workers).length
  const total = list.data?.total ?? q.counts[status] ?? 0
  const go = (s, p = 0) => navigate(queuePath(name, `?status=${s}${p ? "&page=" + p : ""}`))
  const setPaused = paused => act(paused ? "Queue paused" : "Queue resumed",
    () => post(queuePath(name, paused ? "/pause" : "/resume")), { undo: () => setPaused(!paused) })
  const noun = LABELS[status].toLowerCase()

  return html`
    <${PageHead} title=${name} badge=${q.paused && html`<${PausedBadge} />`}
      meta=${[workers ? `${plural(workers, "worker")} online` : "No workers online",
        `${fmt(q.totals.complete)} completed`, `${fmt(q.totals.failed)} failed all time`]}
      actions=${html`<${FindJob} queue=${name} />
        ${!READ_ONLY && html`
          <${Button} icon=${q.paused ? "play" : "pause"} onClick=${() => setPaused(!q.paused)}>${q.paused ? "Resume" : "Pause"}</${Button}>
          <${Button} kind="primary" icon="plus" onClick=${() => setAdding({})}>Add job</${Button}>`}`} />
    ${q.paused && html`<div class="banner neutral"><${Icon} name="pause" />
      <div>This queue is paused. Workers won't start new jobs until you resume it.</div></div>`}
    ${workers > 0 && !q.plugin && html`<div class="banner warning"><${Icon} name="alert" /><div>
      <strong>Finished jobs, pausing and cron aren't tracked</strong>
      Workers on this queue don't run the saq-board plugin. Wrap their settings: <code>settings = with_board(settings)</code></div></div>`}
    <div>
      <nav class="tabs" role="tablist" aria-label="Job status" ref=${tabs}>
        ${[...STATUSES, "workers"].map(s => {
          const n = s === "workers" ? workers : q.counts[s]
          return html`<${Link} key=${s} role="tab" aria-selected=${s === status}
              class=${cx("tab", s === status && "active")} to=${queuePath(name, "?status=" + s)}>
            ${s !== "workers" && html`<span class=${"swatch s-" + s} />`}${LABELS[s]}
            <span class=${cx("n", s === "failed" && n > 0 && s !== status && "hot")}>${fmt(n)}</span></${Link}>`
        })}
      </nav>
    </div>
    ${status === "workers" ? html`<${Workers} workers=${q.workers} />` : html`
      <div class="toolbar">
        <div class="actions"><${BulkActions} queue=${name} status=${status} total=${total} /></div>
        <${Pager} total=${total} page=${page} pageSize=${pageSize} onPage=${p => go(status, p)} />
      </div>
      ${list.error && !list.data ? html`<${ErrorBanner} error=${list.error} />`
        : !list.data ? html`<${Skeleton} />`
        : list.data.jobs.length ? html`<section class="surface flush job-list" aria-label=${`${LABELS[status]} jobs`}>
            <div class="job-row head"><span /><span>Job</span><span>Attempts</span><span class="end">Duration</span>
              <span class="end">${TIME_COLUMN[status]}</span><span /></div>
            ${list.data.jobs.map(job => html`<${JobRow} key=${job.key} job=${job} status=${status}
              onDuplicate=${READ_ONLY ? null : j => setAdding(duplicateOf(j))} />`)}
          </section>`
        : html`<${Empty} title=${`No ${noun} jobs`}>
            ${FINISHED.includes(status) && !q.plugin ? "Finished jobs are recorded by workers running the saq-board plugin."
              : `Jobs show up here while they're ${noun === "active" ? "running" : noun}.`}<//>`}`}
    ${adding && html`<${AddJob} queue=${name} functions=${q.functions || []} initial=${adding} onClose=${() => setAdding(null)} />`}`
}

function JobPage({ queue, jobKey }) {
  const { act, navigate } = useContext(Ctx)
  const [adding, setAdding] = useState(null)
  const [raw, setRaw] = useState(false)
  const { data, error } = useApi(`/queues/${enc(queue)}/jobs/${enc(jobKey)}`)
  const functions = useApi(adding ? queuePath(queue) : null).data?.queue.functions || []
  if (error && !data) return html`<${ErrorBanner} error=${error} />`
  if (!data) return html`<${Skeleton} rows=${1} />`

  const job = data.job
  const status = jobStatus(job)
  const took = runtime(job)
  const actions = jobActions(job, {
    act, onDuplicate: READ_ONLY ? null : j => setAdding(duplicateOf(j)),
    onRemoved: () => navigate(queuePath(queue, "?status=" + job.status)),
  })
  const main = actions.find(a => a.main)
  const hasResult = job.result != null || job.status === "complete"
  const hasMeta = job.meta && Object.keys(job.meta).length > 0

  return html`
    <${PageHead} title=${job.function}
      badge=${html`<${Tag} status=${status} />${job.meta?.cron && html`<${Link} class="tag s-scheduled"
        to=${cronPath({ queue: job.queue, name: job.meta.cron })}>cron · ${job.meta.cron}</${Link}>`}`}
      meta=${[html`<span class="mono">${job.key}</span>`, html`<${Link} to=${queuePath(queue)}>${queue}</${Link}>`,
        html`<${Time} ms=${jobTime(job, status)} prefix=${`${TIME_COLUMN[status] || "Updated"} `} />`]}
      actions=${actions.length > 0 && actions.map(a => html`<${Button} key=${a.name} icon=${a.icon}
        kind=${a === main ? "primary" : a.risky && "risky"} onClick=${a.onClick}>${a.label}</${Button}>`)} />
    <div class="job-page">
      <div>
        ${job.error && html`<${Surface} title="Error" actions=${html`<${CopyButton} text=${job.error} label="Copy error" />`}>
          <${Code} value=${job.error} error /></${Surface}>`}
        ${hasResult && html`<${Surface} title="Result"><${Code} value=${job.result} /></${Surface}>`}
        <${Surface} title="Data" actions=${html`<${CopyButton} text=${JSON.stringify(job.kwargs ?? {}, null, 2)} label="Copy data" />`}>
          <${Code} value=${job.kwargs ?? {}} /></${Surface}>
        <${Surface} title="Options"><dl class="facts large">
          ${Object.entries(jobOptions(job)).map(([k, v]) => html`<dt key=${k} class="mono">${k}</dt><dd class="mono">${String(v)}</dd>`)}
        </dl></${Surface}>
        ${hasMeta && html`<${Surface} title="Meta"><${Code} value=${job.meta} /></${Surface}>`}
        <${Surface} title="Raw job" actions=${html`<${Button} kind="ghost" small icon=${raw ? "down" : "right"}
          onClick=${() => setRaw(!raw)}>${raw ? "Hide JSON" : "Show JSON"}</${Button}>`}>
          ${raw ? html`<${Code} value=${job} />` : html`<p class="muted">Everything SAQ stores for this job, as JSON.</p>`}
        </${Surface}>
      </div>
      <div>
        <${Surface} title="Details"><dl class="facts large">
          <dt>Status</dt><dd><${Tag} status=${status} /></dd>
          <dt>Queue</dt><dd><${Link} to=${queuePath(queue)}>${queue}</${Link}></dd>
          <dt>Function</dt><dd class="mono">${job.function}</dd>
          <dt>Attempts</dt><dd class="tabular">${job.attempts} of ${job.retries}</dd>
          ${took && html`<dt>${took.running ? "Running for" : "Duration"}</dt><dd class="tabular">${duration(took.ms)}</dd>`}
          ${job.status === "active" && job.progress > 0 && html`<dt>Progress</dt><dd><${Progress} value=${job.progress} /></dd>`}
          ${job.timeout ? html`<dt>Timeout</dt><dd>${duration(job.timeout * 1000)}</dd>` : null}
          ${job.worker_id && html`<dt>Worker</dt><dd class="mono">${job.worker_id}</dd>`}
        </dl></${Surface}>
        <${Surface} title="Timeline"><${Timeline} job=${job} /></${Surface}>
      </div>
    </div>
    ${adding && html`<${AddJob} queue=${queue} functions=${functions} initial=${adding} onClose=${() => setAdding(null)} />`}`
}

// ---------------------------------------------------------------- cron

function cronActions(cron, { act, onDeleted }) {
  if (READ_ONLY) return {}
  const run = (action, message, opts) => act(message, () => post(cronPath(cron) + "/" + action), opts)
  const setEnabled = on => run(on ? "enable" : "disable", `${on ? "Enabled" : "Disabled"} ${cron.name}`, { undo: () => setEnabled(!on) })
  return {
    enqueue: () => run("enqueue", `Enqueued ${cron.name}`),
    toggle: { label: cron.enabled ? "Disable" : "Enable", icon: "power", onSelect: () => setEnabled(!cron.enabled) },
    remove: !cron.enabled && {
      label: "Delete", icon: "trash", risky: true,
      onSelect: () => run("delete", `Deleted ${cron.name}`, {
        confirm: { title: `Delete cron job ${cron.name}?`, body: "It comes back when a worker that defines it restarts.", label: "Delete cron job" },
        then: onDeleted,
      }),
    },
  }
}

const pyRepr = v => v === true ? "True" : v === false ? "False" : v == null ? "None" : JSON.stringify(v)

// cleanup(older_than_days=30) · queue default · retries 3
const cronDefinition = c => [
  `${c.function}(${Object.entries(c.kwargs || {}).map(([k, v]) => `${k}=${pyRepr(v)}`).join(", ")})`,
  `queue ${c.queue}`,
  ...["timeout", "retries", "ttl", "heartbeat"].filter(k => c[k] != null).map(k => `${k} ${c[k]}`),
]

function CronRow({ cron: c }) {
  const { act } = useContext(Ctx)
  const actions = cronActions(c, { act })
  return html`<tr class=${c.enabled ? "" : "disabled"}>
    <td class="dim"><${Link} class="name-link" to=${cronPath(c)}>${c.name}</${Link}>
      ${c.description && html`<div class="desc">${c.description}</div>`}
      <div class="cron-def dots">${cronDefinition(c).map(part => html`<span key=${part}>${part}</span>`)}</div></td>
    <td class="dim"><span class="cron-expr">${c.cron}</span><div class="sub caption muted">${c.tz}</div></td>
    <td class="dim nowrap">${c.enabled ? html`<${Time} ms=${c.next_run} />` : html`<span class="muted">—</span>`}</td>
    <td class="dim nowrap">${c.last_enqueued ? html`<${Time} ms=${c.last_enqueued} />` : html`<span class="muted">Never</span>`}</td>
    <td><${EnabledBadge} enabled=${c.enabled} /></td>
    ${!READ_ONLY && html`<td><div class="row-actions">
      <${Button} small icon="zap" onClick=${actions.enqueue}>Enqueue now</${Button}>
      <${Menu} label=${`More actions for ${c.name}`} items=${[actions.toggle, actions.remove && "-", actions.remove]} />
    </div></td>`}
  </tr>`
}

function CronPage() {
  const { act } = useContext(Ctx)
  const [filter, setFilter] = useState("")
  const { data, error } = useApi("/cron")
  if (error && !data) return html`<${ErrorBanner} error=${error} />`
  if (!data) return html`<${Skeleton} rows=${3} />`

  const crons = data.cron.filter(c => `${c.name} ${c.function} ${c.queue} ${c.description}`.toLowerCase().includes(filter.toLowerCase()))
  const enabled = data.cron.filter(c => c.enabled).length
  const bulk = (action, verb, confirm) => act(r => `${verb} ${plural(r.count, "cron job")}`,
    () => post(`/cron/${action}-all`), { confirm })
  const n = data.cron.length

  return html`
    <${PageHead} title="Cron jobs" meta=${[plural(n, "job"), `${fmt(enabled)} enabled`]}
      actions=${html`
        ${n > 5 && html`<div class="search-box"><${Icon} name="search" />
          <input class="input" placeholder="Filter cron jobs" aria-label="Filter cron jobs" value=${filter} onInput=${e => setFilter(e.target.value)} /></div>`}
        ${!READ_ONLY && n > 0 && html`
          <${Button} icon="zap" onClick=${() => bulk("enqueue", "Enqueued", {
            title: `Enqueue all ${n} cron jobs now?`, body: "Each one runs once now, on top of its schedule.",
            label: `Enqueue ${plural(n, "job")}`, danger: false })}>Enqueue all</${Button}>
          <${Menu} large label="More cron actions" items=${[
            { label: "Enable all", icon: "power", onSelect: () => bulk("enable", "Enabled") },
            { label: "Disable all", icon: "power", onSelect: () => bulk("disable", "Disabled", {
              title: "Disable all cron jobs?", body: "They stop running on schedule until you enable them.", label: "Disable all" }) },
            "-",
            { label: "Delete all", icon: "trash", risky: true, onSelect: () => bulk("delete", "Deleted", {
              title: "Delete all cron jobs?", body: "They come back when workers that define them restart.", label: "Delete all" }) },
          ]} />`}`} />
    ${!n ? html`<${Empty} icon="clock" title="No cron jobs yet">
        Define them in your worker settings, then wrap the settings with <code>with_board()</code>.
        <pre class="code">"cron_jobs": [CronJob(cleanup, cron="0 * * * *", description="Hourly cleanup")]</pre>
      <//>`
      : !crons.length ? html`<${Empty} icon="search" title="No cron jobs match">Nothing matches “${filter}”.
        <div style="margin-top: 16px"><${Button} small onClick=${() => setFilter("")}>Clear filter</${Button}></div><//>`
      : html`<div class="surface flush table-wrap"><table class="table comfortable">
        <thead><tr><th>Name</th><th>Schedule</th><th>Next run</th><th>Last enqueued</th><th>Status</th>
          ${!READ_ONLY && html`<th class="num">Actions</th>`}</tr></thead>
        <tbody>${crons.map(c => html`<${CronRow} key=${c.queue + c.name} cron=${c} />`)}</tbody>
      </table></div>`}`
}

function CronDetail({ queue, name }) {
  const { act, navigate } = useContext(Ctx)
  const { data, error } = useApi(`/cron/${enc(queue)}/${enc(name)}`)
  if (error && !data) return html`<${ErrorBanner} error=${error} />`
  if (!data) return html`<${Skeleton} rows=${2} />`
  const c = data.cron
  const options = ["timeout", "heartbeat", "retries", "ttl"].filter(k => c[k] != null)
  const actions = cronActions(c, { act, onDeleted: () => navigate("/cron") })

  return html`
    <${PageHead} title=${c.name} badge=${html`<${EnabledBadge} enabled=${c.enabled} />`} meta=${[c.description]}
      actions=${!READ_ONLY && html`
        <${Button} kind="primary" icon="zap" onClick=${actions.enqueue}>Enqueue now</${Button}>
        <${Button} icon="power" onClick=${actions.toggle.onSelect}>${actions.toggle.label}</${Button}>
        ${actions.remove && html`<${Button} kind="risky" icon="trash" onClick=${actions.remove.onSelect}>Delete</${Button}>`}`} />
    <div class="grid-2">
      <${Surface} title="Details"><dl class="facts large">
        <dt>Queue</dt><dd><${Link} to=${queuePath(c.queue)}>${c.queue}</${Link}></dd>
        <dt>Function</dt><dd class="mono">${c.function}</dd>
        <dt>Schedule</dt><dd><span class="cron-expr">${c.cron}</span> <span class="muted">${c.tz}</span></dd>
        <dt>Next run</dt><dd>${c.enabled ? html`<${Time} ms=${c.next_run} />` : "—"}</dd>
        <dt>Last enqueued</dt><dd>${c.last_enqueued ? html`<${Time} ms=${c.last_enqueued} />` : "Never"}</dd>
        <dt>Last job</dt><dd>${c.last_key ? html`<${Link} class="mono" to=${`/queues/${enc(c.queue)}/jobs/${enc(c.last_key)}`}>${c.last_key}</${Link}>` : "—"}</dd>
        <dt>Unique</dt><dd>${c.unique ? "Yes, skips a run while the previous one is pending" : "No"}</dd>
        ${options.map(k => html`<dt key=${k}>${k[0].toUpperCase() + k.slice(1)}</dt><dd class="tabular">${c[k]}</dd>`)}
      </dl></${Surface}>
      <${Surface} title="Kwargs" actions=${html`<${CopyButton} text=${JSON.stringify(c.kwargs ?? {}, null, 2)} label="Copy kwargs" />`}>
        <${Code} value=${c.kwargs} /></${Surface}>
    </div>
    ${c.history.length ? html`<${Surface} flush title="History"><div class="table-wrap"><table class="table">
        <thead><tr><th>Enqueued</th><th>Scheduled for</th><th>Trigger</th><th>Job</th></tr></thead>
        <tbody>${c.history.map(h => html`<tr key=${h.key + h.at}>
          <td class="nowrap"><${Time} ms=${h.at} /></td>
          <td class="nowrap"><${Time} ms=${h.run_at} /></td>
          <td><span class=${cx("tag fill", h.manual && "blue")}>${h.manual ? "Manual" : "Schedule"}</span></td>
          <td>${h.skipped ? html`<span class="muted">Skipped: ${h.skipped}</span>`
            : html`<${Link} class="mono" to=${`/queues/${enc(c.queue)}/jobs/${enc(h.key)}`}>${h.key}</${Link}>`}</td>
        </tr>`)}</tbody>
      </table></div></${Surface}>`
      : html`<${Empty} icon="clock" title="Not enqueued yet">Runs show up here once the job is enqueued.<//>`}`
}

// ---------------------------------------------------------------- app

function App() {
  const [route, setRoute] = useState(parseRoute)
  const [settings, setSettings] = useState(() => ({ ...DEFAULTS, ...local.get("settings", {}) }))
  const [theme, setThemeState] = useState(() => local.get("theme", "auto"))
  const [tick, setTick] = useState(0)
  const [online, setOnline] = useState(true)
  const [notice, setNotice] = useState(null)
  const [question, setQuestion] = useState(null)
  const [menu, setMenu] = useState(false)
  const timer = useRef()

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

  const refresh = useCallback(() => setTick(t => t + 1), [])

  // One toast at a time; a new one replaces the old.
  const dismiss = useCallback(() => { clearTimeout(timer.current); setNotice(null) }, [])
  const toast = useCallback((message, { error = false, undo } = {}) => {
    clearTimeout(timer.current)
    setNotice({ id: Math.random(), message, error, undo })
    timer.current = setTimeout(() => setNotice(null), undo ? 10000 : error ? 8000 : 6000)
  }, [])

  const ask = useCallback(confirm => new Promise(resolve => setQuestion({
    ...confirm, onAnswer: yes => { setQuestion(null); resolve(yes) },
  })), [])

  const act = useCallback(async (message, fn, { confirm, then, undo } = {}) => {
    if (confirm && !(await ask(confirm))) return
    try {
      const result = await fn()
      toast(typeof message === "function" ? message(result) : message, { undo })
      if (then) then(result)
    } catch (error) {
      toast(error.message, { error: true })
    }
    setTick(t => t + 1)
  }, [])

  const setSetting = useCallback((key, value) => setSettings(current => {
    const next = { ...current, [key]: value }
    local.set("settings", next)
    return next
  }), [])

  const setTheme = useCallback(value => { applyTheme(value); setThemeState(value) }, [])

  const context = { settings, setSetting, theme, setTheme, tick, refresh, online, setOnline, navigate, act, toast }
  return html`<${Ctx.Provider} value=${context}><${Shell} route=${route} menu=${menu} setMenu=${setMenu} />
    <div class="toasts" role="status" aria-live="polite">${notice && html`<div key=${notice.id} class=${cx("toast", notice.error && "error")}>
      <${Icon} name=${notice.error ? "alert" : "check"} /><span>${notice.message}</span>
      ${notice.undo && html`<button type="button" class="undo" onClick=${() => { const undo = notice.undo; dismiss(); undo() }}>Undo</button>`}
      <button type="button" class="close" aria-label="Dismiss" onClick=${dismiss}><${Icon} name="x" /></button>
    </div>`}</div>
    ${question && html`<${ConfirmDialog} ...${question} />`}
  </${Ctx.Provider}>`
}

function Shell({ route, menu, setMenu }) {
  const queues = useApi("/queues")
  let crumbs = [{ label: "Overview" }]
  let page = html`<${Overview} queues=${queues.data?.queues} error=${queues.error} />`
  let title = "Overview"

  useEffect(() => {
    if (!menu) return undefined
    const escape = event => { if (event.key === "Escape") setMenu(false) }
    document.addEventListener("keydown", escape)
    return () => document.removeEventListener("keydown", escape)
  }, [menu])

  if (route.name === "queue") {
    crumbs = [{ label: "Overview", to: "/" }, { label: route.queue }]
    page = html`<${QueuePage} key=${route.queue} name=${route.queue} query=${route.query} />`
    title = route.queue
  } else if (route.name === "job") {
    crumbs = [{ label: "Overview", to: "/" }, { label: route.queue, to: queuePath(route.queue) }, { label: shortKey(route.job) }]
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
    page = html`<${Empty} icon="alert" title="Page not found"><${Link} to="/">Back to the overview →</${Link}><//>`
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
