// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// The networks Humanity runs on: an Engine network (env-engine's EngineSession:
// People, Asset Hub, Bulletin, the identity backend) or, for runtime-only
// scenarios, an owned relay-less People node (env-relayless's ManualSealSession).
// Until refactor step 7 part b env-engine's `LabSession` was this union and its
// `validateSession`/`checkSession` dispatched on it; each adapter now owns its
// record, and the example that uses both composes them here. Hosts reach either
// through the domain's HostNetworkRoutes (`networkRoutes`).
import { readFileSync } from "node:fs";
import type { HostNetworkRoutes } from "@parity/product-lab/domain";
import {
  checkEngineSession,
  engineRoutes,
  validateEngineSession,
  type EngineSession,
  type ReadinessOptions,
  type RuntimeDependency,
} from "@parity/product-lab/env-engine";
import {
  checkManualSealSession,
  manualSealRoutes,
  validateManualSealSession,
  type ManualSealSession,
} from "@parity/product-lab/env-relayless";
import type { JsonRpcClient } from "@parity/product-lab/ports/system";

export type NetworkSession = EngineSession | ManualSealSession;

const isFast = (input: unknown) => !!input && typeof input === "object" && (input as { schemaVersion?: unknown }).schemaVersion === 2;

/** Parse and check a session record of either kind (schema 1: Engine; schema 2: fast People node). */
export function validateNetworkSession(input: unknown): NetworkSession {
  return isFast(input) ? validateManualSealSession(input) : validateEngineSession(input);
}

export function readNetworkSession(file: string): NetworkSession {
  return validateNetworkSession(JSON.parse(readFileSync(file, "utf8")));
}

/** Check a recorded session against the running network (the Engine is attached again; the fast node's peer, anchor and runtime are checked). */
export function checkNetworkSession(rpc: JsonRpcClient, session: NetworkSession, options?: ReadinessOptions): Promise<NetworkSession> {
  return session.schemaVersion === 2 ? checkManualSealSession(rpc, session, options) : checkEngineSession(rpc, session, options);
}

/** How a host reaches the network: an Engine network completely, a fast node People only. */
export function networkRoutes(session: NetworkSession): HostNetworkRoutes {
  return session.schemaVersion === 2 ? manualSealRoutes(session) : engineRoutes(session);
}

/** Attaching owns no node processes and promises no rollback of chain history. */
export class AttachedNetwork implements RuntimeDependency<NetworkSession> {
  readonly isolation = "shared-attached" as const;
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly session: NetworkSession,
  ) {}
  start() {
    return checkNetworkSession(this.rpc, this.session);
  }
  reset() {
    return checkNetworkSession(this.rpc, this.session);
  }
  async stop() {
    /* The manual playground belongs to its launcher. */
  }
}
