// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** DEVELOPMENT BUILDS ONLY: pin our outgoing video to one rung of the
 * adaptive-upload ladder, to compare the lowest upload against normal. Open
 * any page with ?sendRung=<full|lean|low|minimum|survival>; a production build
 * never reads it (lib/debug/dev-url.ts). It is read once at module load from
 * the landing URL and lives in memory only: it survives client-side
 * navigation, a reload clears it, nothing is persisted. The pin is a ceiling:
 * pressure may still move the rung lower. The driver imports this module,
 * which keeps it in the root layout's graph so it sees the landing URL. */
import { VIDEO_RUNGS, type SendRungIndex } from "./send-adaptation-classifier"
import { devUrlParam } from "../debug/dev-url"

export const parseSendRung = (name: string | null | undefined): SendRungIndex | undefined => VIDEO_RUNGS.find((rung) => rung.name === name)?.index

/** the pin `search` asks for; always undefined in a production build */
export const resolveSendRungPin = (search: string): SendRungIndex | undefined => parseSendRung(devUrlParam("sendRung", search))

const pin = typeof window === "undefined" ? undefined : resolveSendRungPin(window.location.search)

export const sendRungPin = (): SendRungIndex | undefined => pin
