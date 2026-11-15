// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Inline icon set on the app's 24-grid, 2px round strokes, currentColor. */
import type { CSSProperties } from "react";

const FALLBACK_ICON = `<path d="M12 4l1.7 4.6L18.3 10.3l-4.6 1.7L12 16.6l-1.7-4.6L5.7 10.3l4.6-1.7L12 4z"/><path d="M18.5 3.5v3M17 5h3"/>`;

const ICONS: Record<string, string> = {
  x: `<path d="M6 6l12 12M18 6L6 18"/>`,
  ellipsis: `<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>`,
  "chevron-right": `<path d="M9 5l7 7-7 7"/>`,
  "chevron-left": `<path d="M15 5l-7 7 7 7"/>`,
  "arrow-left": `<path d="M19 12H5m6-7l-7 7 7 7"/>`,
  check: `<path d="M5 13l4 4L19 7"/>`,
  gamepad: `<rect x="2.5" y="7.5" width="19" height="10" rx="5"/><path d="M8 10.5v4M6 12.5h4"/><circle cx="15.5" cy="11.2" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="13.6" r="1" fill="currentColor" stroke="none"/>`,
  users: `<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c0-3.2 2.4-5 5.5-5s5.5 1.8 5.5 5"/><circle cx="16.8" cy="9.5" r="2.5"/><path d="M16.5 14.7c2.6.3 4 1.9 4 4.3"/>`,
  pen: `<path d="M17 3.5l3.5 3.5L8 19.5 3 21l1.5-5L17 3.5z"/><path d="M14.5 6l3.5 3.5"/>`,
  lock: `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>`,
  sparkle: FALLBACK_ICON,
  ticket: `<path d="M4 8.2A2.2 2.2 0 016.2 6h11.6A2.2 2.2 0 0120 8.2v1.3a2.5 2.5 0 000 5v1.3a2.2 2.2 0 01-2.2 2.2H6.2A2.2 2.2 0 014 15.8v-1.3a2.5 2.5 0 000-5V8.2z"/><path d="M14.5 6.5v11" stroke-dasharray="2.4 2.6"/>`,
  coins: `<circle cx="9.2" cy="9.8" r="5.3"/><path d="M12.5 18.6a5.3 5.3 0 105.9-8.5"/>`,
  smartphone: `<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.8 18.3h2.4"/>`,
  gift: `<rect x="4" y="8" width="16" height="4" rx="1"/><path d="M6 12v7a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0018 19v-7M12 8v12.5"/><path d="M12 8c-2.8 0-4.4-1-4.4-2.6C7.6 4 8.7 3.2 9.9 3.6c1.5.5 2.1 2.6 2.1 4.4zm0 0c2.8 0 4.4-1 4.4-2.6 0-1.4-1.1-2.2-2.3-1.8-1.5.5-2.1 2.6-2.1 4.4z"/>`,
  hand: `<path d="M8.5 11.5V5.8a1.4 1.4 0 012.8 0v4.7m0-5.7v-1a1.4 1.4 0 012.8 0v6.7m0-5.2a1.4 1.4 0 012.8 0v7.2"/><path d="M8.5 12.6v-1a1.4 1.4 0 00-2.8 0v3.9c0 3.7 2.6 6 6.6 6 3.4 0 5.6-2 6.3-4.8l.3-1.4"/>`,
  user: `<circle cx="12" cy="8.6" r="3.8"/><path d="M4.8 20.5c0-3.6 3.1-5.7 7.2-5.7s7.2 2.1 7.2 5.7"/>`,
  message: `<path d="M12 20a8 8 0 10-6.9-3.9L4 20l3.9-1.1A8 8 0 0012 20z"/>`,
  alarm: `<circle cx="12" cy="13.5" r="7"/><path d="M12 9.8v3.7l2.6 2M5.5 3.5L3 6m15.5-2.5L21 6"/>`,
  grid: `<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>`,
  touch: `<path d="M9.5 11.5V4.9a1.9 1.9 0 013.8 0v6.1l3.3.9a2.6 2.6 0 011.9 3l-.7 3a2.7 2.7 0 01-2.6 2.1h-3.6a5 5 0 01-4-2l-2.3-3a1.8 1.8 0 012.5-2.5l1.7 1.2z"/><path d="M6.2 5.2a6 6 0 011.6-2M17 3.2a6 6 0 011.6 2" opacity="0.55"/>`,
  at: `<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.3a2.4 2.4 0 004.8 0V12a8.4 8.4 0 10-3.2 6.6"/>`,
  // The S is two half-circles (r 1.6) joined by three straight runs, not a
  // freehand bezier, which came out asymmetric and collapsed into a blob at
  // the 42px empty-state size. Geometry is Lucide's
  // circle-dollar-sign S scaled 0.8 about (12,12) so it clears this set's
  // r 8.6 ring instead of Lucide's r 10. Lucide (https://lucide.dev) is
  // ISC-licensed, Copyright (c) Lucide Contributors; see
  // https://lucide.dev/license.
  dollar: `<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2v9.6"/><path d="M15.2 8.8H10.4a1.6 1.6 0 100 3.2h3.2a1.6 1.6 0 110 3.2H8.8"/>`,
  qr: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM19 19h2v2h-2z"/>`,
};

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 20, className, style }: IconProps) {
  const body = ICONS[name] ?? FALLBACK_ICON;
  return (
    <svg
      className={"icn" + (className ? " " + className : "")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
