// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// The system ports this example's own code uses outside a lab session (the
// CLI scripts, the Cucumber support code, the fork bootstraps): the ones the
// composition root builds (`NodeSystem` from @product-lab/composition, refactor
// step 9), never Node adapters wired by hand. Inside the lab the runtime hands
// the same ports to its environments and sessions
// (`EnvironmentStartContext.system`, `SessionContext.system`).
import { NodeSystem, processEnvironment } from "@parity/product-lab/composition";
import type { SystemPorts } from "@parity/product-lab/ports/system";

/** The composition root's system ports for this example; run manifests under `<root>/.product-lab/runs`. */
export function nodeSystem(root = process.cwd()): SystemPorts {
  return new NodeSystem(processEnvironment()).forLab(root);
}

export type HumanitySystem = SystemPorts;
