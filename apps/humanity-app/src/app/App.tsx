// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { RouterProvider } from "@tanstack/react-router";

import { AppErrorBoundary } from "./AppErrorBoundary.tsx";
import { AppProviders } from "./providers.tsx";
import { router } from "./router/index.tsx";

export function App() {
  return (
    <AppProviders>
      <AppErrorBoundary>
        <RouterProvider router={router} />
      </AppErrorBoundary>
    </AppProviders>
  );
}
