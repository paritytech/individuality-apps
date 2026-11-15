// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The values of a deploy network that Humanity's deploy scripts read
 * themselves (its DotNS suffix and web gateway), taken from the network's
 * Trinity stack descriptor. bulletin-deploy 0.25 dropped its environment
 * catalog, so this is where `setup.ts` and `publish-pocket-cards.mts` learn
 * them. Values that only feed `DotNS.connect` are not read here: the script
 * passes `env` and bulletin-deploy resolves them from its own copy.
 */

import { decodeLink } from "@parity/trinity-stack";
import { createStackReader, service } from "@parity/trinity-stack/reader";
import type { Descriptor } from "@parity/trinity-stack";

/**
 * Each deploy environment's default descriptor link. A link names one network
 * incarnation (its key and URL), so update it here when a network resets, or
 * override it per run without editing this file (see `STACK_LINK_ENV`).
 * `paseo-next-v2` has no default: set `HUMANITY_STACK_LINK_PASEO_NEXT_V2` to
 * the link its network operators publish, or the cross-check is skipped.
 */
export const STACK_LINKS: Readonly<Record<string, string>> = {
  preview:
    "polkadotapp://stack?key=0x4d43362f03d5511632a210632d1fb7760b5a663580f12ffca34619f79357e239&url=https%3A%2F%2Fpreviewnet.substrate.dev%2F.well-known%2Ftrinity-stack.json",
};

/** The environment variable that overrides each environment's link. */
export const STACK_LINK_ENV: Readonly<Record<string, string>> = {
  preview: "HUMANITY_STACK_LINK_PREVIEW",
  "paseo-next-v2": "HUMANITY_STACK_LINK_PASEO_NEXT_V2",
};

/**
 * The descriptor link for an environment: its override variable when set and
 * non-empty, else the default in `STACK_LINKS`, else undefined.
 */
export function stackLink(
  envId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const variable = STACK_LINK_ENV[envId];
  const override = variable === undefined ? undefined : env[variable]?.trim();
  return override ? override : STACK_LINKS[envId];
}

export interface NetworkValues {
  /** DotNS suffix a bare label is deployed under, without the dot. */
  tld: string;
  /** Host of the stack's web gateway, when it names one. */
  gateway: string | undefined;
}

/** The slice of a descriptor this module reads. */
export type DescriptorSlice = Pick<Descriptor, "tld" | "services">;

/** Reads the values out of an already fetched descriptor. */
export function valuesFromDescriptor(descriptor: DescriptorSlice): NetworkValues {
  let gateway: string | undefined;
  try {
    const url = service(descriptor as Descriptor, "web-gateway").urls[0];
    gateway = url === undefined ? undefined : new URL(url).host;
  } catch {
    gateway = undefined;
  }
  return { tld: descriptor.tld, gateway };
}

/** Reads one environment's values; injectable so tests need no network. */
export type ReadNetworkValues = (envId: string) => Promise<NetworkValues>;

/**
 * Fetches the environment's descriptor and reads its values. Throws when the
 * environment has no link or the descriptor cannot be fetched or verified.
 */
export const readNetworkValues: ReadNetworkValues = async (envId) => {
  const link = stackLink(envId);
  if (link === undefined) {
    const variable = STACK_LINK_ENV[envId];
    throw new Error(
      `No Trinity stack link is known for the "${envId}" environment` +
        (variable === undefined ? "." : `; set ${variable} to check against one.`),
    );
  }
  const reader = createStackReader({ refresh: "once", timeoutMs: 15_000 });
  try {
    const { descriptor } = await reader.get(decodeLink(link));
    return valuesFromDescriptor(descriptor);
  } finally {
    reader.close();
  }
};

/** Whether the opt-out variable is on: only "1" or "true" (any case) counts. */
export function stackCheckDisabled(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export type TargetCheck =
  | { status: "match" }
  | { status: "skipped"; note: string }
  | { status: "drift"; lines: string[] };

/**
 * Compares a script's copy of an environment's `tld` and `gateway` with the
 * live network descriptor. An unreachable descriptor is "skipped", never a
 * failure: a flaky network must not block a deploy over a cross-check.
 */
export async function checkTarget(
  envId: string,
  target: { tld: string; gateway: string },
  read: ReadNetworkValues = readNetworkValues,
): Promise<TargetCheck> {
  let upstream: NetworkValues;
  try {
    upstream = await read(envId);
  } catch (error) {
    return {
      status: "skipped",
      note: `skipped the descriptor cross-check for "${envId}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const lines = [
    upstream.tld === target.tld ? null : `tld: this script says "${target.tld}", the descriptor says "${upstream.tld}"`,
    upstream.gateway === undefined || upstream.gateway === target.gateway
      ? null
      : `gateway: this script says "${target.gateway}", the descriptor says "${upstream.gateway}"`,
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? { status: "match" } : { status: "drift", lines };
}
