// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Verifies an sr25519 VRF signature over an airdrop transcript, the check the
 * pallet runs.
 *
 * A draw entry signed under any key but the playing one fails the whole
 * sign-up on chain and costs the fee, on every retry. `mintAccountAirdropVrfs`
 * checks only that each part is bytes, and product-sdk-individuality exports
 * no verify, so the sign-up checks each entry here before it goes out.
 * No other product mints account VRFs, so the check stays here.
 *
 * This reproduces the schnorrkel verify of `@scure/sr25519` with the
 * transcript as a parameter, over the same merlin implementation. The
 * transcript is the SDK `VrfTranscript`, byte labels and all, which is what
 * `airdropVrfTranscript` builds and what the host signs.
 *
 * The merlin transcript is `__tests`, the library's test-only export, which a
 * release may change without notice. So the package pins `@scure/sr25519`
 * exactly, and vrf.test.ts is the check before the pin moves.
 */
import { ed25519, ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js"
import { bytesToNumberLE } from "@noble/curves/utils.js"
import { __tests } from "@scure/sr25519"
import type { VrfTranscript } from "@parity/product-sdk-individuality"

const { SigningContext } = __tests
const RistrettoPoint = ristretto255.Point
const CURVE_ORDER = ed25519.Point.Fn.ORDER
const PRE_OUTPUT_BYTES = 32
const PROOF_BYTES = 64

/** schnorrkel `vrf_create_hash`, then the fresh transcript the DLEQ proof runs on. */
function vrfInput(spec: VrfTranscript, publicKey: Uint8Array) {
  // Merlin takes the label as bytes, whatever the constructor typing says.
  const transcript = new SigningContext(spec.label as unknown as string)
  for (const item of spec.items) transcript.appendMessage(item.label, item.value)
  const publicPoint = RistrettoPoint.fromBytes(publicKey)
  transcript.commitPoint("vrf-nm-pk", publicPoint)
  const hash = transcript.challengeBytes("VRFHash", 64)
  const deriveToCurve = ristretto255_hasher.deriveToCurve
  if (deriveToCurve === undefined) throw new Error("ristretto255 hash-to-curve is unavailable")
  const input = deriveToCurve(hash)
  transcript.clean()
  return { input, publicPoint, dleq: new SigningContext("VRF") }
}

/** Whether `preOutput` and `proof` are a VRF over `spec` under `publicKey`. */
export function verifyVrf(
  publicKey: Uint8Array,
  spec: VrfTranscript,
  signature: { preOutput: Uint8Array; proof: Uint8Array },
): boolean {
  if (signature.preOutput.length !== PRE_OUTPUT_BYTES || signature.proof.length !== PROOF_BYTES) return false
  const bytes = new Uint8Array([...signature.preOutput, ...signature.proof])
  let publicPoint: InstanceType<typeof RistrettoPoint>
  let output: InstanceType<typeof RistrettoPoint>
  try {
    publicPoint = RistrettoPoint.fromBytes(publicKey)
    output = RistrettoPoint.fromBytes(bytes.subarray(0, 32))
  } catch {
    return false
  }
  if (publicPoint.equals(RistrettoPoint.ZERO)) return false
  const c = bytesToNumberLE(bytes.subarray(32, 64))
  const s = bytesToNumberLE(bytes.subarray(64, 96))
  if (c >= CURVE_ORDER || s >= CURVE_ORDER) return false

  const { input, dleq } = vrfInput(spec, publicKey)
  dleq.protoName("DLEQProof")
  dleq.commitPoint("vrf:h", input)
  dleq.commitPoint("vrf:R=g^r", publicPoint.multiply(c).add(RistrettoPoint.BASE.multiply(s)))
  dleq.commitPoint("vrf:h^r", output.multiply(c).add(input.multiply(s)))
  dleq.commitPoint("vrf:pk", publicPoint)
  dleq.commitPoint("vrf:h^sk", output)
  const expected = dleq.challengeScalar("prove")
  dleq.clean()
  return expected === c
}
