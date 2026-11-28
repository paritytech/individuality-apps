// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

(() => {
  "use strict"

  const zone = "Europe/Zurich"
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })

  const parts = (date) => Object.fromEntries(local.formatToParts(date).map((part) => [part.type, part.value]))
  const dateKey = ({ year, month, day }) => `${year}-${month}-${day}`
  const previousDate = ({ year, month, day }) => {
    const previous = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) - 1))
    return previous.toISOString().slice(0, 10)
  }
  const localInstant = (year, month, day, hour) => {
    const wanted = Date.UTC(year, month - 1, day, hour)
    let candidate = wanted
    for (let index = 0; index < 3; index += 1) {
      const seen = parts(new Date(candidate))
      const seenAsUtc = Date.UTC(Number(seen.year), Number(seen.month) - 1, Number(seen.day), Number(seen.hour), Number(seen.minute), Number(seen.second))
      candidate += wanted - seenAsUtc
    }
    return candidate
  }
  const nextFreshnessBoundary = (now) => {
    const current = parts(now)
    const today = localInstant(Number(current.year), Number(current.month), Number(current.day), 9)
    if (now.getTime() < today) return today
    const tomorrow = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day) + 1))
    return localInstant(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 9)
  }

  let boundaryTimer = null
  const refresh = (now = new Date()) => {
    const current = parts(now)
    const today = dateKey(current)
    const beforeDeadline = Number(current.hour) < 9
    const suite = document.querySelector("[data-suite-status]")
    if (suite) {
      const label = suite.querySelector?.("[data-suite-label]") ?? suite
      const dated = Boolean(suite.dataset.suiteDate)
      const fresh = suite.dataset.suiteDate === today
        || (beforeDeadline && suite.dataset.suiteDate === previousDate(current))
      label.textContent = suite.dataset.suiteClassification === "nightly" && dated && !fresh
        ? "Tonight's crew run isn't published yet"
        : suite.dataset.suiteState === "started"
          ? "In progress"
          : suite.dataset.suiteResult
    }

    for (const recording of document.querySelectorAll("[data-recording-expires-at]")) {
      if (now.getTime() < Date.parse(recording.dataset.recordingExpiresAt)) continue
      const label = recording.querySelector("[data-recording-label]")
      const links = recording.querySelectorAll?.("[data-recording-link]") ?? [recording.querySelector("[data-recording-link]")].filter(Boolean)
      const videos = recording.querySelectorAll?.("[data-recording-video]") ?? [recording.querySelector("[data-recording-video]")].filter(Boolean)
      for (const link of links) { if (link.remove) link.remove(); else link.removeAttribute("href") }
      for (const video of videos) {
        video.removeAttribute?.("src")
        video.load?.()
        video.remove?.()
      }
      if (label) label.textContent = "Video expired"
      recording.classList?.add("recording-expired")
    }

    if (boundaryTimer !== null) clearTimeout(boundaryTimer)
    const candidates = [...document.querySelectorAll("[data-recording-expires-at]")]
      .map((recording) => Date.parse(recording.dataset.recordingExpiresAt))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now.getTime())
    if (suite?.dataset.suiteClassification === "nightly") candidates.push(nextFreshnessBoundary(now))
    if (candidates.length > 0) {
      const boundary = Math.min(...candidates)
      boundaryTimer = setTimeout(() => refresh(new Date()), Math.max(0, boundary - now.getTime()))
    }
  }

  window.__previewNetCrewRefresh = refresh
  refresh()
})()
