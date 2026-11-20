#!/usr/bin/env bash
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

# The deploy workflow's "Determine domain" decision, as a script so a test can
# pin it. Reads DOTNS_DOMAIN, EVENT, PR_NUMBER, SUFFIX, STAGING_SUFFIX, TARGET
# and DEPLOY_ENV, and prints label=, dotns=, product= and staging= lines.
#
# `label` has no TLD and is what the browser URL is built from. `dotns` carries
# the network's suffix and is what the CLI and the manifest must both name.
# `product` is what gets compiled into the artifacts. It is the release name
# for every leg but a paseo PR sandbox: the staging leg so release.yml can
# promote its CIDs, and the previewnet PR leg because only the release name is
# allowlisted for lite proofs.
set -euo pipefail

if ! [[ "$DOTNS_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "::error title=DOTNS_DOMAIN_JOLLITY is not a DotNS label::Set the DOTNS_DOMAIN_JOLLITY secret to the bare label the product deploys under, without a TLD." >&2
  exit 1
fi

RELEASE="${DOTNS_DOMAIN}${SUFFIX}"
STAGING=""
if [ "$EVENT" = "pull_request" ]; then
  LABEL="${DOTNS_DOMAIN}-pr${PR_NUMBER}-sandbox00"
  if [ "$DEPLOY_ENV" = "preview" ]; then
    PRODUCT="$RELEASE"
  else
    PRODUCT="${LABEL}${SUFFIX}"
  fi
else
  if [ "${TARGET:-}" = "release" ]; then
    LABEL="$DOTNS_DOMAIN"
  else
    LABEL="${DOTNS_DOMAIN}${STAGING_SUFFIX}"
    STAGING=1
  fi
  PRODUCT="$RELEASE"
fi
echo "label=${LABEL}"
echo "dotns=${LABEL}${SUFFIX}"
echo "product=${PRODUCT}"
echo "staging=${STAGING}"
