// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { QueryClient } from "@tanstack/react-query";

// No global mutation `onError`: a failure is the calling feature's to show or
// log in its own terms, never a raw error dumped on the user.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
