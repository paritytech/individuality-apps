// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* The orbit: where the camera stands around the sphere's centre, as yaw and
   pitch in degrees. Raw inputs are kept normalised and the TARGET is
   re-derived from them and CAMERA.* every frame, then eased — so a dial tweak
   or a toggle never snaps the view, it eases to the new limit or back to the
   front. Nothing here is cached at construction.

   gyro   deviceorientation → the device's quaternion (W3C ZX'Y'' Euler, in
          three.js's y-up relabelling: Euler(β, α, −γ, 'YXZ') — in that frame
          the device's screen normal is +y, its right +x, its top −z). The
          pose at the first event is the baseline; the camera stands where the
          VIEWER is, relative to the phone, in that baseline: turn the phone to
          face right and you look in from its left, at the left side. Done
          with quaternions, not raw β/γ, because the Euler angles are singular
          at β ≈ 90° — the upright phone, the pose that matters.
   mouse  pointer position over the window, −1..1 each axis (fine pointers).
   Distance isn't the orbit's business: gl.js keeps layout.D so px stay px. */

import * as THREE from 'three'

/* the rig's own dials. config.js re-exports them, so the panel and applyParams
   reach CAMERA where every other table lives — but nothing here reads config. */
export const CAMERA = {
  gyro: false, // JOLLITY: no gyroscope, no iOS motion prompt //       toggle: orbit from device orientation (phones)
  mouse: false, //     toggle: orbit from the pointer position (desktop, fine pointers only; ?mouse=1)
  swing: 25, //        deg — how far the camera may orbit from the front view, each axis
  gyroGain: 1.5, //    camera degrees per degree the phone turns
  mouseGain: 1, //     1 = the window's edge is the full swing
  smoothMs: 250, //    easing time constant toward the target angle
}

const DEG = Math.PI / 180
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const PROBE_MS = 600 // how long a granted phone gets to send its first event

export function createOrbit() {
  let yaw = 0
  let pitch = 0
  const mouseN = { x: 0, y: 0 } // −1..1
  const gyroN = { yaw: 0, pitch: 0 } // deg the viewer sits off the screen normal
  let gyroActive = false // events are arriving
  let listening = false // the deviceorientation listener is installed
  let gyroEnabled = false // access is ours: granted, or never needed (no iOS gate)
  let gyroState = 'idle' // idle | armed | prompting | granted | denied | unavailable | error: …
  let disarm = null // tears down the one-shot gesture listeners, when armed
  let asking = null // the request in flight, so two gestures can't both prompt
  let manual = null // set(): a fixed target (tests, demos)

  let q0 = null // baseline pose
  const q = new THREE.Quaternion()
  const qInv = new THREE.Quaternion()
  const euler = new THREE.Euler()
  const n = new THREE.Vector3()

  /* viewer direction in the device frame: (q⁻¹ · q0)·ŷ — where the person who
     was on the screen normal (+y here) at baseline is now, relative to the
     phone. x is the device's right, −z the top of its screen */
  function orientation(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return
    euler.set(e.beta * DEG, e.alpha * DEG, -e.gamma * DEG, 'YXZ')
    q.setFromEuler(euler)
    if (!q0) q0 = q.clone()
    n.set(0, 1, 0).applyQuaternion(q0).applyQuaternion(qInv.copy(q).invert())
    gyroN.yaw = Math.atan2(n.x, n.y) / DEG // viewer to the phone's right → camera at +x
    gyroN.pitch = Math.atan2(-n.z, Math.hypot(n.x, n.y)) / DEG // viewer toward the top → camera above
    gyroActive = true
  }

  function listen() {
    if (listening) return
    listening = true
    window.addEventListener('deviceorientation', orientation)
  }

  /* One shot on the first RELEASE anywhere — the black background counts, so it
     costs no tickets. All three come down together: whichever fires wins. */
  function armGesture() {
    if (disarm) return
    gyroState = 'armed'
    const evs = ['pointerup', 'click', 'keyup']
    const onGesture = () => {
      disarm?.()
      enableGyro()
    }
    disarm = () => {
      disarm = null
      for (const ev of evs) document.removeEventListener(ev, onGesture, true)
    }
    for (const ev of evs) document.addEventListener(ev, onGesture, true)
  }

  /* Safe at boot, NO gesture needed — and it must never call requestPermission()
     outside one: that rejects with NotAllowedError and on some iOS versions burns
     the request until a reload. So just listen. Where there is no iOS gate
     (Android, desktop) events start at once; on an iOS origin already granted
     they also start, with no prompt — that is the whole reload fix. On an origin
     not yet granted the listener is silently dead, so if nothing has arrived
     shortly we arm a gesture to ask on. Idempotent. */
  function armGyro() {
    if (gyroEnabled || disarm) return
    if (!CAMERA.gyro) return
    if (typeof DeviceOrientationEvent === 'undefined') {
      gyroState = 'unavailable'
      return
    }
    listen()
    if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
      gyroEnabled = true // no gate to pass: whether a sensor answers is another matter
      gyroState = 'granted'
      return
    }
    // granted already? iOS fires at ~60 Hz, so one event inside PROBE_MS settles it
    setTimeout(() => {
      if (gyroActive) {
        gyroEnabled = true
        gyroState = 'granted'
      } else if (!gyroEnabled) armGesture()
    }, PROBE_MS)
  }

  /* The request itself, which iOS allows only inside a user gesture — and for
     touch that is the RELEASE (pointerup / touchend / click) or a key; pointerdown
     does not count and Safari rejects it with NotAllowedError. Call it from a
     gesture handler (armGyro's one-shot does, so does the cap's pointerup).
     Idempotent; comes back false when denied or unavailable, re-arming so the
     next tap retries (iOS answers 'denied' without a prompt until a reload) */
  function enableGyro() {
    if (gyroEnabled) return Promise.resolve(true)
    // the cap's release and the armed one-shot can both land on the same tap
    if (!asking) asking = ask().finally(() => (asking = null))
    return asking
  }

  async function ask() {
    if (!CAMERA.gyro) return false
    if (typeof DeviceOrientationEvent === 'undefined') {
      gyroState = 'unavailable'
      return false
    }
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        gyroState = 'prompting'
        const r = await DeviceOrientationEvent.requestPermission()
        if (r !== 'granted') {
          gyroState = r
          console.warn(`[orbit] motion access ${r}`)
          armGesture() // a later tap may still be answered yes
          return false
        }
      }
    } catch (err) {
      gyroState = `error: ${err?.message ?? err}`
      console.warn('[orbit] motion access failed:', err)
      armGesture()
      return false
    }
    gyroEnabled = true
    gyroState = 'granted'
    listen()
    return true
  }

  function mouse(x, y, W, H) {
    mouseN.x = clamp((x / Math.max(1, W) - 0.5) * 2, -1, 1)
    mouseN.y = clamp(-(y / Math.max(1, H) - 0.5) * 2, -1, 1) // screen y is down; pitch is up
  }

  function step(dt) {
    const swing = Math.max(0, CAMERA.swing)
    let ty = 0
    let tp = 0
    if (manual) {
      ty = manual.yaw
      tp = manual.pitch
    } else if (gyroActive && CAMERA.gyro) {
      ty = gyroN.yaw * CAMERA.gyroGain
      tp = gyroN.pitch * CAMERA.gyroGain
    } else if (CAMERA.mouse) {
      ty = mouseN.x * CAMERA.mouseGain * swing
      tp = mouseN.y * CAMERA.mouseGain * swing
    }
    ty = clamp(ty, -swing, swing)
    tp = clamp(tp, -swing, swing)
    const tau = Math.max(0, CAMERA.smoothMs) / 1000
    const a = tau > 1e-4 ? 1 - Math.exp(-dt / tau) : 1
    yaw += (ty - yaw) * a
    pitch += (tp - pitch) * a
    return { yaw, pitch }
  }

  return {
    step,
    mouse,
    armGyro, // at boot: listen, and arm a gesture to ask on if nothing arrives
    enableGyro, // inside a gesture: ask
    /* stop listening: the sensor and any gesture still armed to ask on */
    dispose() {
      disarm?.()
      if (listening) window.removeEventListener('deviceorientation', orientation)
      listening = false
    },
    orientation, // feed a { alpha, beta, gamma } by hand (tests)
    /* the current pose becomes the front view */
    recenter() {
      q0 = gyroActive ? q.clone() : null // the last pose read, now — not the next event's
      gyroN.yaw = gyroN.pitch = 0
    },
    /* fixed target in degrees; set() with no arguments hands control back */
    set(y, p) {
      manual = y == null ? null : { yaw: y, pitch: p ?? 0 }
    },
    get yaw() {
      return yaw
    },
    get pitch() {
      return pitch
    },
    get gyroActive() {
      return gyroActive
    },
    get gyroEnabled() {
      return gyroEnabled
    },
    get gyroState() {
      return gyroState
    },
  }
}
