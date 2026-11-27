// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineLab } from "@parity/product-lab";
import { paseoCopy, previewnetGenesis } from "@parity/product-lab/composition";
import { openingSessions } from "./lab/opening/session.ts";


export default defineLab({
  name: "DIM2 source opening",
  environments: {
    ...paseoCopy({
      ...(process.env.JOLLITY_LAB_FORK_DIRECTORY ? { directory: process.env.JOLLITY_LAB_FORK_DIRECTORY, seedsDir: `${process.env.JOLLITY_LAB_FORK_DIRECTORY}/seeds` } : {}),
    }),
    // The local dev chain: Engine's Previewnet started from genesis (product-lab 0.3.0); DIM2 builds for `local` there.
    ...previewnetGenesis(),
  },
  defaultEnvironment: "paseo-copy",
  apps: {
    dim2: {
      label: "DIM2 source",
      requires: { chains: ["people", "asset-hub", "bulletin"], services: ["identity-backend"] },
    },
  },
  features: ["e2e/dim2-opening.feature", "e2e/dim2-opening-wrong-state.feature"],
  steps: ["lab/opening/steps.ts"],
  sessions: openingSessions,
});
