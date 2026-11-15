// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Humanity's daily-dollar registry: the shared core
 * (`@individuality/daily-dollar`) over the common record, with Humanity's
 * planner defaults. The app and the headless worker both read and write it;
 * the app once also kept the ids of the Daily Dollar pushes it booked here,
 * Jollity's chat worker books those now.
 *
 * Records written while the worker still posted to chat carry an `announced`
 * list; Humanity adds no fields to the common record, so it is simply not
 * read back.
 */
import {
  COMMON_RECORD_FIELDS,
  createDailyDollarRegistry,
  type DrawRecord,
  type RegistryPlanConfig,
  type ScheduledNotification,
} from "@individuality/daily-dollar";

/**
 * Defaults the worker and the app share; overridable per deployment.
 * `stuckRegistrationSeconds` outlasts a live attempt's own signing and
 * finality deadlines (`register-draws.ts`: 60 s + 120 s).
 */
export const DEFAULT_REGISTRY_PLAN_CONFIG: RegistryPlanConfig = {
  registerRetryBackoffSeconds: [30],
  stuckRegistrationSeconds: 240,
  retentionSeconds: 14 * 86_400,
};

export const {
  emptyRegistry,
  sanitizeRegistry,
  reconcileRegistry,
  planRegistrations,
  applyRegistrationSubmitted,
  applyRegistrationResult,
  applyNotificationCancelled,
  applyScratched,
} = createDailyDollarRegistry<ScheduledNotification, DrawRecord>({
  fields: COMMON_RECORD_FIELDS,
  defaultConfig: DEFAULT_REGISTRY_PLAN_CONFIG,
});
