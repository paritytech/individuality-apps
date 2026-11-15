// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Whether the "state" debug overlay is built in.
 *
 * `VITE_DEBUG_PANEL=true` puts it in any build (including a deployed one),
 * `=false` keeps it out of any build, and unset follows the build: present in
 * `vite dev`, absent in production.
 *
 * Both operands are build-time literals — Vite substitutes `import.meta.env`
 * dot access at transform time — so this folds to a constant and the panel plus
 * its stylesheet drop out of a build that has it off, rather than shipping
 * unreachable code. Live in its own module so a gate can import it without
 * pulling in the rest of the environment.
 */
export const DEBUG_PANEL: boolean =
  import.meta.env.VITE_DEBUG_PANEL === "true" ||
  (import.meta.env.VITE_DEBUG_PANEL !== "false" && import.meta.env.DEV);
