// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ReactNode } from "react";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";

import { queryClient } from "@shared/chain/query-client.ts";
import {
  dropRetiredCacheScopes,
  persistOptions,
} from "@shared/chain/query-persistence.ts";

// Once per load, before the persister restores: entries an earlier schema
// version wrote are dropped rather than left behind.
dropRetiredCacheScopes();

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
