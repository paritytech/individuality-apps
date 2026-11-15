// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What a game gave the player, as it lands on chain: the player's attendance
 * (decided early, or at the settle; ./attendance-rule.ts, ./attendance.ts,
 * ./attendance-watch.ts), the settle itself (./settle.ts), reads repeated
 * before it (./before-settle.ts), and the credits the game earned
 * (./credits.ts). The credits' chain side is ./chain, a subpath of its own.
 */
export {
  attendanceInGame,
  attendanceStatus,
  type Attendance,
  type AttendanceRow,
  type AttendanceStatus,
  type GameSlot,
} from "./attendance-rule"
export { deriveAttendance, type AttendanceVerdict, type AttendanceView } from "./attendance"
export { attendanceWatch, type AttendanceReads, type AttendanceWatch } from "./attendance-watch"
export {
  isSettled,
  SETTLE_POLL_MS,
  SETTLE_TIMEOUT_MS,
  settleWait,
  type SettleOptions,
  type SettleReads,
  type SettleWait,
} from "./settle"
export {
  BEFORE_SETTLE_REREAD_MS,
  readBeforeSettle,
  readUntilSettle,
  UNTIL_SETTLE_BACKSTOP_MS,
  type BeforeSettleOptions,
  type UntilSettleOptions,
} from "./before-settle"
export { gameCredits, type Credit, type CreditState, type GameCredits } from "./credits"
