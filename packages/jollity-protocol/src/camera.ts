// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The camera answer, handed from the app to the chat worker through host
 * storage, so the card can draw its camera line without asking for the camera.
 *
 * The app writes it per product, under `${CAMERA_KEY}:${productAccount()}`, as
 * the JSON string "on" or "off".
 */
export const CAMERA_KEY = "jollity.camera.v1"
