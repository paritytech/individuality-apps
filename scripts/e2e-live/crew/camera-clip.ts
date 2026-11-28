// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { join } from "node:path"

export type CameraClipResolution = "360p" | "720p"

export const identityCameraClipPath = (dir: string, identityKey: string, resolution: CameraClipResolution): string =>
  join(dir, `${identityKey}-${resolution}.y4m`)

export const harnessCameraClipPath = (dir: string, profile: string, resolution: CameraClipResolution): string =>
  join(dir, `harness-${profile}-${resolution}.y4m`)
