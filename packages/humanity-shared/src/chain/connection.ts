// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { getWsProvider } from "@polkadot-api/ws-provider";
import { Binary, createClient, type PolkadotClient } from "polkadot-api";

import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { childSpan } from "@humanity/shared/telemetry/flow.ts";
import {
  ChainNotSupportedError,
  getHostProvider,
  isInsideContainerSync,
} from "./host-api.ts";

export function isInHost(): boolean {
  return isInsideContainerSync();
}

interface CachedClient {
  promise: Promise<PolkadotClient>;
}

const clientCache = new Map<`0x${string}`, CachedClient>();
const logger = loggerFor("chain", "connection");

export type ProviderFailureReason =
  | "bridge-unavailable"
  | "host-declined-chain"
  | "threw";

export interface ProviderDiagnostics {
  readonly provider: "host-bridge" | "ws";
  readonly failureReason?: ProviderFailureReason;
  readonly acquisitionMs: number;
}

let providerDiagnostics: ProviderDiagnostics | undefined;

class HostProviderAcquisitionError extends Error {
  constructor(
    readonly reason: ProviderFailureReason,
    genesis: `0x${string}`,
  ) {
    super(`Host chain provider unavailable for ${genesis}: ${reason}`);
    this.name = "HostProviderAcquisitionError";
  }
}

function recordProviderDiagnostics(diagnostics: ProviderDiagnostics): void {
  providerDiagnostics = diagnostics;
  if (diagnostics.failureReason == null) {
    logger.debug(
      "chain provider selected; provider={provider} elapsedMs={elapsedMs}",
      {
        provider: diagnostics.provider,
        elapsedMs: diagnostics.acquisitionMs,
      },
    );
    return;
  }
  logger.warning(
    "host chain provider unavailable; reason={reason} elapsedMs={elapsedMs}",
    {
      reason: diagnostics.failureReason,
      elapsedMs: diagnostics.acquisitionMs,
    },
  );
}

/** The outcome of the most recent People-chain provider acquisition. */
export function getProviderDiagnostics(): ProviderDiagnostics | undefined {
  return providerDiagnostics;
}

export interface GetClientOptions {
  /** Injectable host check; overridable in tests to force the WS path. */
  inHost?: () => boolean;
  /** Metadata cache slot: `"people"` keeps the historical bare key. */
  metadataSlot?: "people" | "per-genesis";
}

/**
 * Lazily build and cache a PAPI client per genesis hash.
 *
 * The host bridge is the sole transport in a container; standalone uses the
 * configured WS endpoint.
 */

/**
 * Runtime metadata cached by `:code:` hash, so a launch against an unchanged
 * runtime skips the ~400KB metadata fetch over the bridge that otherwise sits
 * in front of the first storage read (~800ms on a dev host). One entry: a
 * runtime upgrade replaces it. localStorage like the query cache, because the
 * host KV is async and PAPI asks before the first read; absent storage (the
 * worker, Node) just means fetching every time, as before.
 */
interface MetadataCache {
  getMetadata: (codeHash: string) => Promise<Uint8Array | null>;
  setMetadata: (codeHash: string, metadata: Uint8Array) => void;
}
const METADATA_CACHE_KEY = "humanity.papi-metadata";
const HEX_BYTES = /^0x(?:[0-9a-f]{2})+$/i;
/**
 * One cache entry per chain: People keeps its historical bare key, every
 * other chain (Asset Hub) is suffixed with its genesis, so the two no longer
 * evict each other on every launch.
 */
const metadataCacheFor = (genesis: `0x${string}`, suffixed: boolean): MetadataCache => ({
  getMetadata: async (codeHash: string): Promise<Uint8Array | null> => {
    const key = suffixed ? `${METADATA_CACHE_KEY}:${genesis}` : METADATA_CACHE_KEY;
    try {
      const raw = globalThis.localStorage?.getItem(key);
      if (raw == null) return null;
      const sep = raw.indexOf(":");
      if (sep < 0 || raw.slice(0, sep) !== codeHash) return null;
      // `Binary.fromHex` decodes anything, so a damaged entry must be refused
      // here or it becomes metadata PAPI cannot decode, on every launch.
      const hex = raw.slice(sep + 1);
      if (!HEX_BYTES.test(hex)) return null;
      return Binary.fromHex(hex as `0x${string}`);
    } catch {
      return null;
    }
  },
  setMetadata: (codeHash: string, metadata: Uint8Array): void => {
    const key = suffixed ? `${METADATA_CACHE_KEY}:${genesis}` : METADATA_CACHE_KEY;
    try {
      globalThis.localStorage?.setItem(
        key,
        `${codeHash}:${Binary.toHex(metadata)}`,
      );
    } catch {
      /* storage full or unavailable: next launch fetches again */
    }
  },
});

export async function getOrCreateClient(
  genesis: `0x${string}`,
  wsFallback: string,
  options: GetClientOptions = {},
): Promise<PolkadotClient> {
  const { inHost = isInHost, metadataSlot = "people" } = options;
  const metadataCache = metadataCacheFor(genesis, metadataSlot === "per-genesis");
  const cached = clientCache.get(genesis);
  if (cached != null) {
    return cached.promise;
  }

  const entry: CachedClient = { promise: undefined as never };
  entry.promise = (async (): Promise<PolkadotClient> => {
    const startedAt = Date.now();
    if (!inHost()) {
      const client = createClient(getWsProvider(wsFallback), metadataCache);
      recordProviderDiagnostics({
        provider: "ws",
        acquisitionMs: Math.round(Date.now() - startedAt),
      });
      childSpan("chain.connect", "ws")({ ok: true });
      return client;
    }

    // Only the host bridge is worth a span: the WS client above connects
    // lazily and costs nothing here, while the bridge is one host round
    // trip the first flow of a launch always pays for.
    const endConnect = childSpan("chain.connect", "host-bridge");

    try {
      const hostProvider = await getHostProvider(genesis);
      if (hostProvider == null) {
        const reason = "bridge-unavailable";
        recordProviderDiagnostics({
          provider: "host-bridge",
          failureReason: reason,
          acquisitionMs: Math.round(Date.now() - startedAt),
        });
        throw new HostProviderAcquisitionError(reason, genesis);
      }
      const client = createClient(hostProvider, metadataCache);
      recordProviderDiagnostics({
        provider: "host-bridge",
        acquisitionMs: Math.round(Date.now() - startedAt),
      });
      endConnect({ ok: true });
      return client;
    } catch (error) {
      if (error instanceof HostProviderAcquisitionError) {
        endConnect({ ok: false, detail: error.reason });
        throw error;
      }
      const reason =
        error instanceof ChainNotSupportedError ? "host-declined-chain" : "threw";
      recordProviderDiagnostics({
        provider: "host-bridge",
        failureReason: reason,
        acquisitionMs: Math.round(Date.now() - startedAt),
      });
      endConnect({ ok: false, detail: reason });
      throw new HostProviderAcquisitionError(reason, genesis);
    }
  })().catch((error: unknown) => {
    if (clientCache.get(genesis) === entry) {
      clientCache.delete(genesis);
    }
    throw error;
  });
  clientCache.set(genesis, entry);
  return entry.promise;
}

/** Destroy every cached client and empty the cache. */
export async function resetClientCache(): Promise<void> {
  for (const [genesis, entry] of clientCache) {
    clientCache.delete(genesis);
    void entry.promise.then(
      (client) => {
        client.destroy();
      },
      () => undefined,
    );
  }
}
