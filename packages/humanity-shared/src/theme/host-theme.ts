// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Follows the host's live theme (TrUAPI `Theme.subscribe`) by setting
 * `data-theme` on the document root; `apps/humanity-app/src/shared/styles/themes.css`
 * holds one palette per id below, generated from the host's own design system.
 *
 * The wire carries a name and a Light/Dark variant, never colors. iOS sends
 * its theme id as `Custom(id)`, Android the
 * lower-camel theme name — the same ids. A name this build has no palette for
 * (a newer host theme, or `Default`) falls back to Berlin in the reported
 * variant, so the app always matches the host's light/dark at least.
 */
import { getThemeProvider, type ThemeMode } from "@humanity/shared/chain/host-api.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

export type HostThemeId = "berlinNight" | "berlinDay" | "lisbon" | "malta" | "tokyo";

/** Keyed by lower-cased wire name, so `BerlinDay` and `berlinday` match too. */
const THEME_BY_NAME: Record<string, HostThemeId> = {
  berlinnight: "berlinNight",
  berlinday: "berlinDay",
  lisbon: "lisbon",
  malta: "malta",
  tokyo: "tokyo",
};

const logger = loggerFor("theme");

export function resolveHostThemeId(theme: ThemeMode): HostThemeId {
  if (theme.name.tag === "Custom") {
    const key = theme.name.value.toLowerCase();
    const known = Object.hasOwn(THEME_BY_NAME, key) ? THEME_BY_NAME[key] : undefined;
    if (known != null) return known;
  }
  return theme.variant === "Light" ? "berlinDay" : "berlinNight";
}

/** Subscribes for the page's lifetime. Outside a host nothing is set and the
 *  `:root` default (Berlin Night) stays. */
export async function followHostTheme(root: HTMLElement = document.documentElement): Promise<void> {
  const provider = await getThemeProvider();
  if (provider == null) return;
  provider.subscribeTheme((theme) => {
    const id = resolveHostThemeId(theme);
    logger.debug("host theme {name} {variant} -> {id}", { name: theme.name, variant: theme.variant, id });
    root.dataset["theme"] = id;
  });
}
