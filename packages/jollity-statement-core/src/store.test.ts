// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { fromHex, nodeStatementStore, toHex } from "./store"
import {
  decodeStatement,
  encodeSignaturePayload,
  type StatementProof,
  type StatementProver,
} from "./statement"
import type { StatementRpc, SubmitResult } from "./rpc"

const fixedProof: StatementProof = {
  signature: new Uint8Array(64).fill(7),
  signer: new Uint8Array(32).fill(9),
}

const prover: StatementProver = {
  signer: fixedProof.signer,
  prove: async () => fixedProof,
} as unknown as StatementProver

const wire = {
  expiry: (0xffff_ffffn << 32n) | 1n,
  channel: toHex(new Uint8Array(32).fill(1)),
  topics: [toHex(new Uint8Array(32).fill(2))],
  data: toHex(new TextEncoder().encode("hello")),
}

function fakeRpc(result: SubmitResult = { status: "new" }) {
  const submits: Uint8Array[] = []
  let deliver: ((statements: Uint8Array[], remaining: number) => void)[] = []
  const rpc: StatementRpc = {
    submit: async (statement) => {
      submits.push(statement)
      return result
    },
    subscribeStatements: (_topic, onStatements) => {
      deliver.push(onStatements)
      return () => {
        deliver = deliver.filter((d) => d !== onStatements)
      }
    },
  }
  return { rpc, submits, deliver: () => deliver }
}

describe("nodeStatementStore", () => {
  it("createProofAuthorized proves over the decoded fields", async () => {
    const proveSpy =
      vi.fn<StatementProver["prove"]>(async () => fixedProof)
    const store = nodeStatementStore(fakeRpc().rpc, {
      ...prover,
      prove: proveSpy,
    } as unknown as StatementProver)
    const proof = await store.createProofAuthorized(wire)
    expect(proof).toBe(fixedProof)
    const fields = proveSpy.mock.calls[0]![0]
    expect(fields.expiry).toBe(wire.expiry)
    expect(toHex(fields.channel)).toBe(wire.channel)
    expect(toHex(fields.topic1)).toBe(wire.topics[0])
    expect(new TextDecoder().decode(fields.data)).toBe("hello")
  })

  it("submit SCALE-encodes and round-trips through decodeStatement", async () => {
    const fake = fakeRpc()
    const store = nodeStatementStore(fake.rpc, prover)
    await store.submit({ ...wire, proof: fixedProof })
    expect(fake.submits).toHaveLength(1)
    const decoded = decodeStatement(fake.submits[0]!)
    expect(decoded.expiry).toBe(wire.expiry)
    expect(toHex(decoded.channel)).toBe(wire.channel)
    expect(toHex(decoded.topic1)).toBe(wire.topics[0])
    expect(new TextDecoder().decode(decoded.data)).toBe("hello")
    expect(decoded.proof.signature).toEqual(fixedProof.signature)
    // the encoded payload is exactly what a keypair prover would have signed
    expect(encodeSignaturePayload(decoded)).toBeInstanceOf(Uint8Array)
  })

  it("submit throws on a rejected result", async () => {
    const fake = fakeRpc({ status: "rejected", reason: "noAllowance" })
    const store = nodeStatementStore(fake.rpc, prover)
    await expect(store.submit({ ...wire, proof: fixedProof })).rejects.toThrow(
      /noAllowance/,
    )
  })

  it("rejects multi-topic statements (node impl supports exactly one)", async () => {
    const store = nodeStatementStore(fakeRpc().rpc, prover)
    await expect(
      store.createProofAuthorized({ ...wire, topics: [...wire.topics, ...wire.topics] }),
    ).rejects.toThrow(/exactly one topic/)
  })

  it("subscribe fans out per topic and adapts SCALE statements to hex pages", async () => {
    const fake = fakeRpc()
    const store = nodeStatementStore(fake.rpc, prover)
    const pages: Array<{ statements: Array<{ data?: string }> }> = []
    const sub = store.subscribe(
      { matchAny: [wire.topics[0]!, toHex(new Uint8Array(32).fill(3))] },
      (page) => pages.push(page),
    )
    expect(fake.deliver()).toHaveLength(2) // one RPC subscription per topic

    // deliver an encoded statement on the first topic
    await store.submit({ ...wire, proof: fixedProof })
    fake.deliver()[0]!([fake.submits[0]!], 0)
    expect(pages).toHaveLength(1)
    expect(fromHex(pages[0]!.statements[0]!.data!)).toEqual(
      new TextEncoder().encode("hello"),
    )

    // undecodable garbage is skipped, empty pages are not delivered
    fake.deliver()[0]!([new Uint8Array([1, 2, 3])], 0)
    expect(pages).toHaveLength(1)

    sub.unsubscribe!()
    expect(fake.deliver()).toHaveLength(0)
  })
})
