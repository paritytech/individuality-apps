// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * ONE collection coin (lib/coin3d: rounded-hex lofted geometry, engraved
 * canvas atlas on the rim, two-light machined-metal shaders, 16° lean), hosted
 * with plain three.js. Orthographic camera at zoom 1 (one world unit = one CSS
 * pixel), zero frames at rest — every gesture and settle asks for its own
 * frame.
 *
 * The turn gesture is lib/coin3d/useCoinTurn: drag to turn, flick to
 * coast, release settles on a whole face; `onFacetChange` fires once per face
 * crossed (mid-drag included). The wheel maps any number of collections onto
 * the six physical faces.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import * as THREE from "three"
import { facetIndex, SPIN_MS, spinEase, stepAngle } from "@/lib/coin3d/coinGeometry"
import { faceTexts, type FaceText } from "@/lib/coin3d/facetWheel"
import { buildCoinGeometry, COIN_TILT } from "@/lib/coin3d/coinMesh"
import { makeCapMaterial, makeWallMaterial } from "@/lib/coin3d/coinMaterial"
import { buildEngraveAtlas } from "@/lib/coin3d/coinTexture"
import { useCoinTurn, PX_PER_STEP_RATIO } from "@/lib/coin3d/useCoinTurn"

/** the coin's proportions: height over circumradius */
const COIN_HEIGHT_RATIO = 62 / 150
/** the coin's circumradius as a share of the host box's height */
const RC_OF_HEIGHT = 0.42

export interface CoinCanvasHandle {
  /** coast the coin to the face showing collection `index` (shortest way) */
  spinToCollection(index: number): void
}

export const CoinCanvas = forwardRef<
  CoinCanvasHandle,
  {
    /** the wheel: one entry per collection (any count; six physical faces) */
    facets: FaceText[]
    /** fires once per face crossed, with the collection index now at front */
    onFacetChange: (index: number) => void
    className?: string
  }
>(function CoinCanvas({ facets, onFacetChange, className }, handle) {
  const hostRef = useRef<HTMLDivElement>(null)
  const turnsRef = useRef(0)
  const facetsRef = useRef(facets)
  useEffect(() => {
    facetsRef.current = facets
  }, [facets])
  const onFacetRef = useRef(onFacetChange)
  useEffect(() => {
    onFacetRef.current = onFacetChange
  }, [onFacetChange])

  const invalidateRef = useRef<() => void>(() => {})
  const rcRef = useRef(60)

  // ── the three.js half: built once, renders only when asked ───────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    } catch {
      return // no WebGL — the picker still works, the coin is just absent
    }
    renderer.setClearColor(0x000000, 0)
    renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;"
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 6000)
    camera.position.z = 2000

    const built = buildCoinGeometry({ height: COIN_HEIGHT_RATIO })
    const atlas = buildEngraveAtlas({
      faces: faceTexts(Math.round(turnsRef.current), facetsRef.current),
      bandAspect: built.bandAspect,
      flatFraction: built.flatFraction,
    })
    const materials = [makeWallMaterial(atlas.texture), makeCapMaterial()]
    const mesh = new THREE.Mesh(built.geometry, materials)
    const group = new THREE.Group()
    group.rotation.x = COIN_TILT
    group.add(mesh)
    scene.add(group)

    // HOW FAR THE COIN'S TOP EDGE SITS ABOVE THE GROUP'S ORIGIN, at unit
    // scale, measured once. The coin's size is a fraction of its canvas
    // height, and an orthographic camera centres it — so a taller canvas used
    // to push the coin DOWN, away from the beam it stands under, and every
    // size change needed the caller's margin re-tuned to compensate. Anchoring
    // the top instead makes the two independent: the coin grows downward and
    // its top stays exactly where the caller put it.
    // Measured with the mesh unrotated: the silhouette shifts by a pixel or
    // two as it spins, which is not worth making the coin bob for.
    const topUnits = (() => {
      mesh.rotation.y = 0
      group.updateMatrixWorld(true)
      return new THREE.Box3().setFromObject(group).max.y
    })()

    const step = (stepAngle() * Math.PI) / 180
    let lastFront = Math.round(turnsRef.current)
    let raf = 0
    let dead = false
    const render = () => {
      raf = 0
      if (dead) return
      mesh.rotation.y = -step * turnsRef.current
      const front = Math.round(turnsRef.current)
      if (front !== lastFront) {
        lastFront = front
        atlas.setFaceTexts(faceTexts(front, facetsRef.current))
      }
      renderer.render(scene, camera)
    }
    const invalidate = () => {
      if (!raf && !dead) raf = requestAnimationFrame(render)
    }
    invalidateRef.current = invalidate

    const resize = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (!w || !h) return
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
      renderer.setSize(w, h, false)
      camera.left = -w / 2
      camera.right = w / 2
      camera.top = h / 2
      camera.bottom = -h / 2
      camera.updateProjectionMatrix()
      rcRef.current = h * RC_OF_HEIGHT
      group.scale.setScalar(rcRef.current)
      // one world unit is one CSS pixel, so this puts the coin's top edge on
      // the host's top edge (see topUnits)
      group.position.y = h / 2 - topUnits * rcRef.current
      invalidate()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    // the atlas repaints itself when the font lands; draw that repaint
    document.fonts?.ready.then(() => invalidate()).catch(() => {})

    return () => {
      dead = true
      if (raf) cancelAnimationFrame(raf)
      observer.disconnect()
      invalidateRef.current = () => {}
      built.geometry.dispose()
      atlas.dispose()
      for (const material of materials) material.dispose()
      renderer.dispose()
      renderer.forceContextLoss?.()
      renderer.domElement.remove()
    }
    // built once for the mount; facets/f-callbacks flow through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── the turn gesture (lib/coin3d/useCoinTurn) ─────────────────────────────
  useCoinTurn({
    surfaces: [hostRef],
    turnsRef,
    count: () => facetsRef.current.length,
    onFacetChange: (index) => onFacetRef.current(index),
    invalidate: () => invalidateRef.current(),
    pxPerStep: () => rcRef.current * PX_PER_STEP_RATIO,
  })

  // ── spin home / to a collection, with the same settle curve ──────────────
  const homeRafRef = useRef(0)
  useEffect(() => () => cancelAnimationFrame(homeRafRef.current), [])
  useImperativeHandle(handle, () => ({
    spinToCollection(index: number) {
      const count = Math.max(1, facetsRef.current.length)
      const from = turnsRef.current
      const front = Math.round(from)
      const at = facetIndex(front, count)
      let delta = ((index - at) % count + count) % count
      if (delta > count / 2) delta -= count // the short way around
      const to = front + delta
      cancelAnimationFrame(homeRafRef.current)
      const startedAt = performance.now()
      const tick = (now: number) => {
        const p = Math.min(1, (now - startedAt) / SPIN_MS)
        turnsRef.current = from + (to - from) * spinEase(p)
        const i = facetIndex(Math.round(turnsRef.current), count)
        onFacetRef.current(i)
        invalidateRef.current()
        if (p < 1) homeRafRef.current = requestAnimationFrame(tick)
        else turnsRef.current = to
      }
      homeRafRef.current = requestAnimationFrame(tick)
    },
  }))

  return (
    <div
      ref={hostRef}
      className={"relative cursor-grab touch-none select-none active:cursor-grabbing " + (className ?? "")}
      aria-label="Turn the coin to browse collections"
    />
  )
})
