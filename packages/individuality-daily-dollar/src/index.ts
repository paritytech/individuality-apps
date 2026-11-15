// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Daily Dollar, the same in every product: the people-airdrop draw and a
 * person's standing in it (./draw.ts), and the registry core every product
 * keeps its draw records in (./registry.ts). A product instantiates the
 * registry over its own record and keeps its planners, defaults and storage.
 */
export {
  claimableDraw,
  pendingRegistrations,
  type AirdropDraw,
  type AirdropDrawStatus,
  type AirdropParticipation,
  type AirdropStanding,
  type Hex32,
} from "./draw"
export {
  COMMON_RECORD_FIELDS,
  createDailyDollarRegistry,
  DAILY_DOLLAR_REGISTRY_VERSION,
  type DailyDollarRegistry,
  type DailyDollarRegistryOptions,
  type DrawOutcome,
  type DrawRecord,
  type DrawRecordFields,
  type DrawRegistration,
  type LastTick,
  type NotificationKind,
  type RegistrationOutcome,
  type RegistrationSource,
  type RegistrationState,
  type RegistryPlanConfig,
  type ScheduledNotification,
  type TickResult,
} from "./registry"
