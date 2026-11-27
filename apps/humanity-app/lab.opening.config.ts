// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineLab } from "@parity/product-lab";
import { paseoCopy } from "@parity/product-lab/composition";
import { keepBundle, openingSessions } from "./lab/opening/session.ts";

keepBundle();

export default defineLab({
  name: "Humanity source opening",
  environments: paseoCopy({
    ...(process.env.HUMANITY_LAB_FORK_DIRECTORY ? { directory: process.env.HUMANITY_LAB_FORK_DIRECTORY, seedsDir: `${process.env.HUMANITY_LAB_FORK_DIRECTORY}/seeds` } : {}),
  }),
  defaultEnvironment: "paseo-copy",
  apps: {
    peopl: {
      label: "Humanity source",
      requires: { chains: ["people", "asset-hub", "bulletin"], services: ["identity-backend"] },
    },
  },
  features: ["e2e/humanity-opening.feature", "e2e/humanity-opening-wrong-card.feature"],
  steps: ["lab/opening/steps.ts"],
  sessions: openingSessions,
});
