// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function ordinal(day: number): string {
  const rest = day % 100
  if (rest >= 11 && rest <= 13) return `${day}th`
  const last = day % 10
  return `${day}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`
}

/** A countdown as m:ss, or h:mm:ss from an hour out, against the clock of the caller. */
export function formatCountdown(untilUnixSeconds: number, nowUnixSeconds: number): string {
  const total = Math.max(0, untilUnixSeconds - nowUnixSeconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`
}

/** A countdown in minutes and seconds, such as "4m 59s", as the native card writes it. */
export function formatMinutesSeconds(untilUnixSeconds: number, nowUnixSeconds: number): string {
  const total = Math.max(0, untilUnixSeconds - nowUnixSeconds)
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

/** The wall clock in the hour cycle of the phone, "16:00" or "4:00 PM". */
export function formatClock(unixSeconds: number, locale?: string): string {
  const date = new Date(unixSeconds * 1000)
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const hours = date.getHours()
  const { hour12 } = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions()
  if (hour12) return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`
  return `${String(hours).padStart(2, "0")}:${minutes}`
}

/** The date line of the game card, such as "Jan 21st, 16:00". */
export function formatGameDate(unixSeconds: number, locale?: string): string {
  const date = new Date(unixSeconds * 1000)
  return `${MONTHS[date.getMonth()]} ${ordinal(date.getDate())}, ${formatClock(unixSeconds, locale)}`
}

/** The date of a game ahead on the registration card, such as "Oct 7 at 4:00 PM". */
export function formatGameTime(unixSeconds: number, locale?: string): string {
  const date = new Date(unixSeconds * 1000)
  return `${MONTHS[date.getMonth()]} ${date.getDate()} at ${formatClock(unixSeconds, locale)}`
}

/** The day divider of the chat, such as "Wed, 14 Jan". */
export function formatDayDivider(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000)
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/**
 * The unit the player reads a prize in: `NEXT_PUBLIC_PRIZE_UNIT`, which
 * defaults to CASH as lib/draw/prize-unit.ts does in the app.
 */
export function prizeUnit(): string {
  return process.env.NEXT_PUBLIC_PRIZE_UNIT?.trim() || "CASH"
}

/** The amount of a prize alone, "$200". */
export function formatPrizeAmount(amount: number): string {
  return `$${Number.isFinite(amount) && amount >= 0 ? amount : 0}`
}

/** The prize as the app writes it, "$200 CASH", in the unit the player reads. */
export function formatPrize(amount: number): string {
  return `${formatPrizeAmount(amount)} ${prizeUnit()}`
}
