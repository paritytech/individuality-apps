// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Metadata } from "next";
import Script from "next/script";
import localFont from "next/font/local";
import "./globals.css";
import { CrashBoundary } from "@/components/telemetry/crash-boundary";
import { DebugBoot } from "@/components/debug/debug-boot";
import { FrontDoor } from "@/components/front-door";
import { CarriedBubbleLayer } from "@/components/carried-bubble";
import { RESOURCE_COUNTERS_INIT_SCRIPT } from "@/lib/telemetry/resource-counters";

// Dev harness: run the app hosted, in a plain tab, against a local
// `truapi-host` (`npm run dev:host`, scripts/dev-host.mjs). The host serves a
// bridge script that parks a MessagePort on `window.__HOST_API_PORT__` — the
// same thing native webview hosts inject — so nothing above that line changes.
// Development only, and only while the launcher names the host's port: both
// are build-time constants, so a production bundle carries no trace of it
// (verify: grep out/ for __HOST_API_PORT__ after `npm run build`).
const TRUAPI_HOST_PORT =
  process.env.NODE_ENV === "development" ? process.env.NEXT_PUBLIC_TRUAPI_HOST_PORT : undefined;

// Self-hosted (app/fonts/README.md): next/font/google downloads at BUILD time,
// so a network blip on the runner fails the build. The files are the latin
// subset Google serves for these families.
const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

const manrope = localFont({
  src: "./fonts/manrope-latin.woff2",
  variable: "--font-manrope",
  weight: "600 700",
  display: "swap",
});

const martianMono = localFont({
  src: "./fonts/martian-mono-latin.woff2",
  variable: "--font-martian-mono",
  weight: "400",
  display: "swap",
});

// the design system's CASH wordmark (components/prize-text.tsx). Held back
// until it loads rather than swapped in: its fallback would draw a bare "c"
const cashLogo = localFont({
  src: "./fonts/cash-logo-regular.otf",
  variable: "--font-cash-logo",
  weight: "400",
  display: "block",
});

export const metadata: Metadata = {
  title: "Jollity",
  description: "Jollity — the proof-of-personhood video game: copy the gesture on camera with strangers and vote on who was human.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // dark by default — the Polkadot app look is dark-first (Berlin Night is
    // the app's semantic palette)
    <html
      lang="en"
      className={`${inter.variable} ${manrope.variable} ${martianMono.variable} ${cashLogo.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Script
          id="jollity-resource-counters"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: RESOURCE_COUNTERS_INIT_SCRIPT }}
        />
        {TRUAPI_HOST_PORT && (
          <Script
            src={`http://127.0.0.1:${TRUAPI_HOST_PORT}/bootstrap.js`}
            strategy="beforeInteractive"
          />
        )}
        {/* a page load reaches the game's pages through home (lib/front-door) */}
        <CrashBoundary>
          <FrontDoor>{children}</FrontDoor>
        </CrashBoundary>
        <DebugBoot />
        {/* the draw's hold carrying its bubble to /chest, over the route change */}
        <CarriedBubbleLayer />
      </body>
    </html>
  );
}
