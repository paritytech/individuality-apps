// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The records Jollity and Humanity share: the ones one product keeps in
 * its host storage for the other to read through a `trustedProducts` storage
 * grant. Both products import the shapes, keys and lifetimes from here, so
 * neither mirrors the other.
 *
 * Nothing in this package depends on either product or on the host SDK: a
 * record's shape, its key, its lifetimes, and the store that reads, ages and
 * writes it over whatever storage handle a product opens it with.
 */
export * from "./game-registration"
export * from "./game-registration-store"
export * from "./daily-dollar-scratch"
export * from "./game-timing"
export * from "./communication-key"
