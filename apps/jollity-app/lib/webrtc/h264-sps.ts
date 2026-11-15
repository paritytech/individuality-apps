// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SENDER'S H.264 SPS, AS THIS RECEIVER SAW IT (#629). Pure and
 * framework-free: it runs in the encoded-transform worker (sps-tap.worker.ts)
 * and in the tests, never on the media path's critical work.
 *
 * Why: Snapdragon (c2.qti) decoders hold 1-2 frames from iPhone and MediaTek
 * senders but not from Exynos/Tensor ones (#558). The prior art says the
 * trigger is pic_order_cnt_type 0: Chromium switched OpenH264 from POC type 0
 * to 2 in M129 for exactly this, and ExoPlayer #8514 found the Snapdragon
 * fast path keyed on POC type 2. So the fields read here are the ones that
 * say whether a decoder may have to reorder: pic_order_cnt_type, the VUI's
 * bitstream_restriction (max_num_reorder_frames, max_dec_frame_buffering),
 * max_num_ref_frames, plus profile, constraint flags and level.
 *
 * READ THE VUI FIELDS WITH CARE. libwebrtc's receive side runs
 * sps_vui_rewriter in its H.264 depacketizer, BEFORE an encoded transform
 * sees the frame: it adds a bitstream_restriction with
 * max_num_reorder_frames=0 and max_dec_frame_buffering=max_num_ref_frames
 * when the sender's is missing or allows reordering. So on a Chromium (and
 * probably WebKit) receiver "restriction true, reorder 0" may be the
 * rewriter's, not the sender's. pic_order_cnt_type is never rewritten (the
 * slice headers carry pic_order_cnt_lsb under type 0), which is why it is the
 * field that discriminates.
 *
 * Every read is bounds-checked: a short or garbled SPS yields what was read
 * before the end (complete: false), never a throw.
 */

export interface SpsFields {
  profileIdc: number
  /** constraint_set0..5 flags and the 2 reserved bits, as the byte */
  constraintFlags: number
  levelIdc: number
  /** pic_order_cnt_type: 0, 1 or 2; absent if the SPS ended before it */
  pocType?: number
  /** max_num_ref_frames */
  numRefFrames?: number
  /** vui_parameters_present_flag */
  vui?: boolean
  /** bitstream_restriction_flag (false when there is no VUI) */
  bitstreamRestriction?: boolean
  maxNumReorderFrames?: number
  maxDecFrameBuffering?: number
  /** the SPS was read to the end of its VUI (or to a VUI flag of 0) */
  complete: boolean
}

const NAL_SPS = 7

/** profiles whose SPS carries chroma_format_idc, bit depths and scaling lists */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

/** Drop the emulation-prevention byte of every 00 00 03 (the RBSP of a NAL unit). */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length)
  let n = 0
  let zeros = 0
  for (let i = 0; i < nal.length; i++) {
    const byte = nal[i]
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    zeros = byte === 0 ? zeros + 1 : 0
    out[n++] = byte
  }
  return out.subarray(0, n)
}

class OutOfBits extends Error {}

class BitReader {
  private bit = 0
  constructor(private readonly bytes: Uint8Array) {}

  u1(): number {
    const byte = this.bit >> 3
    if (byte >= this.bytes.length) throw new OutOfBits()
    const value = (this.bytes[byte] >> (7 - (this.bit & 7))) & 1
    this.bit++
    return value
  }

  /** n bits, n <= 32, as a non-negative number (no `|`, so a u32 stays positive) */
  u(n: number): number {
    let value = 0
    for (let i = 0; i < n; i++) value = value * 2 + this.u1()
    return value
  }

  ue(): number {
    let zeros = 0
    while (this.u1() === 0) if (++zeros > 31) throw new OutOfBits()
    return 2 ** zeros - 1 + this.u(zeros)
  }

  se(): number {
    const k = this.ue()
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2)
  }
}

function skipScalingList(r: BitReader, size: number): void {
  let last = 8
  let next = 8
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256
    last = next === 0 ? last : next
  }
}

function skipHrd(r: BitReader): void {
  const cpbCount = r.ue() + 1
  r.u(4) // bit_rate_scale
  r.u(4) // cpb_size_scale
  for (let i = 0; i < cpbCount; i++) {
    r.ue() // bit_rate_value_minus1
    r.ue() // cpb_size_value_minus1
    r.u1() // cbr_flag
  }
  r.u(5) // initial_cpb_removal_delay_length_minus1
  r.u(5) // cpb_removal_delay_length_minus1
  r.u(5) // dpb_output_delay_length_minus1
  r.u(5) // time_offset_length
}

/** The VUI up to and including bitstream_restriction, into `out`. */
function readVui(r: BitReader, out: SpsFields): void {
  if (r.u1()) {
    // aspect_ratio_info_present_flag
    if (r.u(8) === 255) r.u(32) // Extended_SAR: sar_width, sar_height
  }
  if (r.u1()) r.u1() // overscan_info_present_flag → overscan_appropriate_flag
  if (r.u1()) {
    // video_signal_type_present_flag
    r.u(3) // video_format
    r.u1() // video_full_range_flag
    if (r.u1()) r.u(24) // colour_description_present_flag → primaries, transfer, matrix
  }
  if (r.u1()) {
    // chroma_loc_info_present_flag
    r.ue()
    r.ue()
  }
  if (r.u1()) {
    // timing_info_present_flag
    r.u(32) // num_units_in_tick
    r.u(32) // time_scale
    r.u1() // fixed_frame_rate_flag
  }
  const nalHrd = r.u1()
  if (nalHrd) skipHrd(r)
  const vclHrd = r.u1()
  if (vclHrd) skipHrd(r)
  if (nalHrd || vclHrd) r.u1() // low_delay_hrd_flag
  r.u1() // pic_struct_present_flag
  out.bitstreamRestriction = r.u1() === 1
  if (!out.bitstreamRestriction) return
  r.u1() // motion_vectors_over_pic_boundaries_flag
  r.ue() // max_bytes_per_pic_denom
  r.ue() // max_bits_per_mb_denom
  r.ue() // log2_max_mv_length_horizontal
  r.ue() // log2_max_mv_length_vertical
  out.maxNumReorderFrames = r.ue()
  out.maxDecFrameBuffering = r.ue()
}

/** Parse one SPS NAL unit (header byte included, still escaped). Null when it
 *  is not an SPS or is too short to hold the profile and level. */
export function parseSps(nal: Uint8Array): SpsFields | null {
  if (nal.length < 4 || (nal[0] & 0x80) !== 0 || (nal[0] & 0x1f) !== NAL_SPS) return null
  const rbsp = unescapeRbsp(nal.subarray(1))
  const out: SpsFields = { profileIdc: rbsp[0], constraintFlags: rbsp[1], levelIdc: rbsp[2], complete: false }
  const r = new BitReader(rbsp.subarray(3))
  try {
    r.ue() // seq_parameter_set_id
    if (HIGH_PROFILES.has(out.profileIdc)) {
      const chromaFormat = r.ue()
      if (chromaFormat === 3) r.u1() // separate_colour_plane_flag
      r.ue() // bit_depth_luma_minus8
      r.ue() // bit_depth_chroma_minus8
      r.u1() // qpprime_y_zero_transform_bypass_flag
      if (r.u1()) {
        // seq_scaling_matrix_present_flag
        const lists = chromaFormat === 3 ? 12 : 8
        for (let i = 0; i < lists; i++) if (r.u1()) skipScalingList(r, i < 6 ? 16 : 64)
      }
    }
    r.ue() // log2_max_frame_num_minus4
    const pocType = r.ue()
    out.pocType = pocType
    if (pocType === 0) {
      r.ue() // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      r.u1() // delta_pic_order_always_zero_flag
      r.se() // offset_for_non_ref_pic
      r.se() // offset_for_top_to_bottom_field
      const cycle = r.ue()
      for (let i = 0; i < cycle; i++) r.se() // offset_for_ref_frame[i]
    }
    out.numRefFrames = r.ue()
    r.u1() // gaps_in_frame_num_value_allowed_flag
    r.ue() // pic_width_in_mbs_minus1
    r.ue() // pic_height_in_map_units_minus1
    if (!r.u1()) r.u1() // frame_mbs_only_flag → mb_adaptive_frame_field_flag
    r.u1() // direct_8x8_inference_flag
    if (r.u1()) {
      // frame_cropping_flag
      r.ue()
      r.ue()
      r.ue()
      r.ue()
    }
    out.vui = r.u1() === 1
    if (out.vui) readVui(r, out)
    else out.bitstreamRestriction = false
    out.complete = true
  } catch (err) {
    if (!(err instanceof OutOfBits)) throw err
  }
  return out
}

/** Offsets [start, end) of each NAL unit in an Annex-B buffer; empty when
 *  there is no start code. */
function annexBUnits(data: Uint8Array): Array<[number, number]> {
  const starts: number[] = []
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3)
      i += 2
    }
  }
  return starts.map((start, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : data.length
    // a 4-byte start code's leading zero belongs to the gap, not the unit
    if (k + 1 < starts.length && end > start && data[end - 1] === 0) end--
    return [start, end]
  })
}

/** Offsets of each NAL unit in a 4-byte length-prefixed (AVCC) buffer, or
 *  null when the lengths do not tile it exactly. */
function avccUnits(data: Uint8Array): Array<[number, number]> | null {
  const units: Array<[number, number]> = []
  let at = 0
  while (at + 4 <= data.length) {
    const len = ((data[at] << 24) >>> 0) + (data[at + 1] << 16) + (data[at + 2] << 8) + data[at + 3]
    if (len === 0 || at + 4 + len > data.length) return null
    units.push([at + 4, at + 4 + len])
    at += 4 + len
  }
  return at === data.length ? units : null
}

/** The first SPS NAL unit in an encoded frame (Annex B, which libwebrtc hands
 *  an encoded transform, or AVCC), or null. */
export function findSpsNal(data: Uint8Array): Uint8Array | null {
  const units = annexBUnits(data)
  for (const [start, end] of units.length > 0 ? units : avccUnits(data) ?? []) {
    if (end > start && (data[start] & 0x1f) === NAL_SPS) return data.subarray(start, end)
  }
  return null
}

/** The SPS of an encoded frame, parsed, or null when it carries none. */
export function spsFromFrame(data: Uint8Array): SpsFields | null {
  const nal = findSpsNal(data)
  return nal ? parseSps(nal) : null
}

const num = (value: number | undefined, absent: string) => (value === undefined ? absent : String(value))

/** The rtc.sps.* attributes, all text. "none" = the field is not in the SPS
 *  (no VUI or no restriction); "unknown" = the SPS ended before it. */
export function spsAttrs(sps: SpsFields): Record<string, string> {
  const vuiRead = sps.bitstreamRestriction !== undefined
  const restriction = sps.bitstreamRestriction === false ? "none" : "unknown"
  return {
    "rtc.sps.poc_type": num(sps.pocType, "unknown"),
    "rtc.sps.vui": sps.vui === undefined ? "unknown" : String(sps.vui),
    "rtc.sps.restriction": vuiRead ? String(sps.bitstreamRestriction) : "unknown",
    "rtc.sps.reorder": num(sps.maxNumReorderFrames, restriction),
    "rtc.sps.dec_buf": num(sps.maxDecFrameBuffering, restriction),
    "rtc.sps.num_ref": num(sps.numRefFrames, "unknown"),
    "rtc.sps.profile": String(sps.profileIdc),
    "rtc.sps.constraints": sps.constraintFlags.toString(16).padStart(2, "0"),
    "rtc.sps.level": String(sps.levelIdc),
    "rtc.sps.complete": String(sps.complete),
  }
}
