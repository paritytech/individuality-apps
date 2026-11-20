// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Visible names are shared by features, CI planning and saved timing views.
export const scenarioNames = {
  "C1": "Sign up in Jollity, Humanity shows it",
  "C2": "Sign up in Humanity, Jollity shows it",
  "C3": "Open Jollity from Humanity",
  "C4": "Play a real game, Humanity's card updates",
  "C5": "Miss a game, both apps show it",
  "C6": "Full loop: Humanity to a game and back",
  "B1": "Apps catch up after being in the background: missed game while Humanity was away",
  "B2": "Apps catch up after being in the background: game result while Humanity was away",
  "B3": "Apps catch up after being in the background: sign-up while Jollity was away",
  "U3": "Jollity's new-version screen: while opening Jollity from Humanity",
  "U4": "Jollity's new-version screen: after a game on the way back"
} as const;
export function plainName(code: keyof typeof scenarioNames): string { return `${scenarioNames[code]} (${code})`; }
export function sourceName(source: string): string {
  if (source === 'background') return 'Apps catch up after being in the background (B1, B2, B3)';
  if (source === 'update') return "Jollity's new-version screen (U3, U4)";
  const match = /^(c[1-6]|b[1-3]|u[34])(?:-([123]))?$/i.exec(source);
  return match ? plainName(match[1]!.toUpperCase() as keyof typeof scenarioNames) + (match[2] ? `, run ${match[2]}` : '') : source;
}
