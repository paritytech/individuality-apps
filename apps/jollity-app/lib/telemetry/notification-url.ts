// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The reminder-notification launch URL, in one place for both sides that touch
 * it: the chat worker builds it (apps/jollity-worker/src/index.ts) and the app
 * parses it (foreground.ts consumes the return, launch-source.ts records the
 * launch). The moment list is the masking-safe vocabulary: anything else maps
 * to `other` so no URL free text reaches Sentry.
 */

export const NOTIFICATION_PARAM = "jollity-notification"
export const REMINDER_VALUE = "reminder"
export const MOMENT_PARAM = "moment"

export const NOTIFICATION_MOMENTS = new Set(["opens", "close-1h", "close-10m", "start-5m", "start-1m", "start-20s"])
