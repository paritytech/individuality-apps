// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The pinned Paseo Asset Hub snapshot the chest's tests deal their claims from.
 *
 * The values were read once from the chain; the script that read them is not
 * part of this repository, so a refresh is a manual edit.
 */
export const FIXTURE_SOURCE = {
  "network": "paseo",
  "genesisHash": "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
  "blockHash": "0xa4b7ce1b7f3b1e19713b43558e4d8896e2759e4c6ee4c57b6812ffcf2de84d49",
  "blockNumber": 1880602
} as const

/**
 * One common and one rare NFT from each collection `getApprovedCollections`
 * approves on Paseo, with the chain metadata manifest and its resolved
 * thumbnail.
 *
 * The tests read only these committed values, and never depend on live chain
 * state.
 */
export const FIXTURE_COLLECTIONS = [
  {
    "id": 26,
    "name": "Sports",
    "items": [
      {
        "index": 3,
        "archetype": "american-football",
        "tier": "Common",
        "rarity": "common",
        "manifest": "bafk2bzacead7lazlr3ka5lhmtotf6n3j5cd66fy5euyvc6utvkbyx72ywnuhm",
        "thumbnail": "bafk2bzacedon27qwlycigrws7ms6dkvi2iw4zfzlxttucn6i3qxdyanxpkb5a"
      },
      {
        "index": 0,
        "archetype": "bobsleigh",
        "tier": "Rare",
        "rarity": "rare",
        "manifest": "bafk2bzacedrrxg2hkjb73pjdvcclru54f4fftqktrzfcyvnmw4rtzwlvahtyu",
        "thumbnail": "bafk2bzacedfu47u2mmsvjtwnrdqbrhnfyh4qkkn53svdj4gedizlmnwjchzjy"
      }
    ]
  },
  {
    "id": 27,
    "name": "Coffee and Tea",
    "items": [
      {
        "index": 5,
        "archetype": "affogato",
        "tier": "Common",
        "rarity": "common",
        "manifest": "bafk2bzacedzzsxqi57a6ftoklo7sgj66vjl5auehzrqe7qmriedk6oakrxzyi",
        "thumbnail": "bafk2bzacedll2uwgxlepdijwmtmyspogemzyw4umplc24t3a446m52cns5hwy"
      },
      {
        "index": 0,
        "archetype": "mazagran",
        "tier": "Rare",
        "rarity": "rare",
        "manifest": "bafk2bzaceaou6ohomn2ou5fsexlqaetyvqtftqmlylft3aq6dgcmtore4a4iy",
        "thumbnail": "bafk2bzacedbbfwpeqgduicaihg7mpr5ejve6yqws5rdfe7goriiixhpnh3pta"
      }
    ]
  },
  {
    "id": 28,
    "name": "Jobs",
    "items": [
      {
        "index": 9,
        "archetype": "accountant",
        "tier": "Common",
        "rarity": "common",
        "manifest": "bafk2bzacedhrk2tjmpdacb4wxpqaoc7xwrgeaheezqjyksjmzuusg4ecfslhg",
        "thumbnail": "bafk2bzacec426hdhwjkdvqxhpk7gsggzbprqhlashjoph57l22hgzw55aifpy"
      },
      {
        "index": 0,
        "archetype": "armour-conservator",
        "tier": "Rare",
        "rarity": "rare",
        "manifest": "bafk2bzacebdgsv2yp27h52sq3j37hgd45r2xadjw4irzhiuyvbcnczidwqexg",
        "thumbnail": "bafk2bzaceavpxeungih47im2dbkh7dm5yrpdbnljo6n6qfwekvnxhyfml5kq2"
      }
    ]
  }
] as const
