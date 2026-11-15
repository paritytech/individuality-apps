// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Sends every player the "Register for the next game now" notice of the game in registration once more.
 *
 * A booking from before this migration already spent that notice, so the
 * chat of the new release opened while registration was open sent nothing.
 * Dropping the `opens:` moment from the record leaves it wanted and not held,
 * and the next poll of bookReminders books it again, a few seconds out. The
 * hour notice, the host reminder and the start reminders of a registered
 * player stay as they are, so none of them comes twice. A notice still to
 * come goes to the stale ids, which that booking cancels before it books the
 * new one. A push that timed out on the old worker is dropped too, and rings
 * twice if the host held it.
 */
import { NOTIFICATIONS_KEY, idsOf, readJSON, tryWriteJSON, type Scheduled, type StorageHost } from "../state"
import type { Migration } from "."

async function run(host: StorageHost): Promise<void> {
  const booked = await readJSON<Scheduled>(host, NOTIFICATIONS_KEY)
  if (booked === undefined) throw new Error("the booking record could not be read")
  // An ids-only record is replaced whole by the next booking, which books the notice anyway.
  if (!booked?.moments) return
  const entries = Object.entries(booked.moments)
  const opening = (moment: string) => moment.startsWith("opens:")
  const moments = Object.fromEntries(entries.filter(([moment]) => !opening(moment)))
  const ids = idsOf(moments)
  const now = Date.now()
  const ahead = entries.flatMap(([moment, { id, at }]) => (opening(moment) && id !== null && at > now ? [{ id, at }] : []))
  const stale = [...(booked.stale ?? []), ...ahead]
  if (!(await tryWriteJSON(host, NOTIFICATIONS_KEY, { ...booked, moments, ids, stale }))) {
    throw new Error("the booking record could not be written")
  }
}

const openingNoticeAgain: Migration = { number: 1, name: "opening-notice-again", run }
export default openingNoticeAgain
