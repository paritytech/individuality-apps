// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN, AS A SOLID — three meshes in one group: the front face, the back
   face and the edge band (profile.js makes them at unit radius; the group's
   scale is the radius). Materials from material.js; the faces' maps are the
   engraving sets from maps.js, handed in by the scene.

   Nothing here decides a look — look(LOOK) copies the live values onto the
   materials every frame (uniforms and setters, no recompile), and the things
   that DO recompile say so by returning true.

   The 3D letters (letters.js) are two more meshes, front and back, each with
   its own material reading its face's normal map (the tops' curve, maps.js);
   letters(side, geometry) swaps one in, or out with null. Each stands on the
   field's lowest point, so its foot sinks into the dish. The letters cast the
   key's shadow and the faces take it; nothing else casts, so there is no
   self-shadowing to bias against. */

import * as THREE from 'three'
import { coinGeometry } from './profile.js'
import { createUniforms, createMetal, setParallax, setSkin, grainFor } from './material.js'
import { skinOf } from './skins/index.js'
import { metalHex } from './look.js'

export function createCoin() {
  const shared = createUniforms()
  const front = createMetal('face', shared, { uSpun: { value: 1 }, uHeight: { value: null } })
  const back = createMetal('face', shared, { uSpun: { value: 1 }, uHeight: { value: null } })
  const edge = createMetal('edge', shared, { uSpun: { value: 0 } }) // a lathe-turned edge: grooves round it, whatever the faces are
  const letterFront = createMetal('letter', shared, { uSpun: { value: 1 } })
  const letterBack = createMetal('letter', shared, { uSpun: { value: 1 } })
  const materials = [front, back, edge, letterFront, letterBack]

  const group = new THREE.Group()
  const meshes = [front, back, edge].map((m) => new THREE.Mesh(new THREE.BufferGeometry(), m))
  group.add(...meshes)
  meshes[0].receiveShadow = meshes[1].receiveShadow = true
  /* the 3D letters: the back's turned half round y, so it reads from behind */
  const letterMesh = { front: new THREE.Mesh(new THREE.BufferGeometry(), letterFront), back: new THREE.Mesh(new THREE.BufferGeometry(), letterBack) }
  letterMesh.back.rotation.y = Math.PI
  for (const m of Object.values(letterMesh)) {
    m.visible = false
    m.castShadow = true
    group.add(m)
  }

  let shapeKey = ''
  let geo = null
  /* rebuild the solid when its proportions change; true when it did */
  function shape(thick, rimW, sides = 0, round = 1, edgeRound = 1) {
    const k = `${thick}|${rimW}|${sides}|${round}|${edgeRound}`
    if (k === shapeKey) return false
    shapeKey = k
    geo = coinGeometry({ thick, rimW, sides, round, edgeRound })
    ;[geo.front, geo.back, geo.edge].forEach((g, i) => {
      meshes[i].geometry.dispose()
      meshes[i].geometry = g
    })
    letterMesh.front.position.z = geo.fieldZ
    letterMesh.back.position.z = -geo.fieldZ
    return true
  }

  /* a face's 3D letters: a geometry from letters.js, or null for none */
  function letters(side, geometry) {
    const m = letterMesh[side]
    m.geometry.dispose()
    m.geometry = geometry ?? new THREE.BufferGeometry()
    m.visible = !!geometry
  }

  /* point a face at its engraving set (after a bake that swapped targets) */
  function maps(which, set) {
    const m = which === 'front' ? front : back
    m.normalMap = set.normal.texture
    m.aoMap = set.orm.texture
    m.userData.uniforms.uHeight.value = set.height?.texture ?? null
    ;(which === 'front' ? letterFront : letterBack).normalMap = set.normal.texture // the caps' curve
  }

  const colour = new THREE.Color()
  let lastHex = ''
  /* the live look; returns true when something forced a recompile */
  let envFactor = 1
  function look(L) {
    const skin = skinOf(L.skin)
    const o = skin.props(L)
    envFactor = o.env ?? 1
    const hex = o.color ?? metalHex(L)
    if (hex !== lastHex) {
      lastHex = hex
      colour.set(hex)
      for (const m of materials) m.color.copy(colour)
    }
    const unbrushed = L.finish === 'polished' || o.brush === false
    shared.uBrush.value = unbrushed ? 0 : L.brush
    shared.uGrain.value = unbrushed ? 0 : L.grain
    shared.uGrainMap.value = grainFor(shared.uGrain.value > 0)
    for (const m of [front, back, letterFront, letterBack]) m.userData.uniforms.uSpun.value = L.finish === 'spun' ? 1 : 0
    // the tops: frosted, a near mirror, or (below 0) the field's own metal, brush and all
    shared.uTopRough.value = L.tops === 'frosted' ? L.frostRoughness : L.tops === 'polished' ? 0.08 : -1
    shared.uTopBrush.value = L.tops === 'brushed' ? 1 : 0
    shared.uWallRough.value = L.wallRoughness
    shared.uPomDepth.value = L.height / 100 // one letter height, in UV (the diameter is 1)
    shared.uPomSteps.value = Math.round(Math.min(32, Math.max(4, L.parallaxSteps)))
    shared.uReeds.value = Math.max(0, Math.round(L.reeds))
    shared.uReedAmp.value = L.reeds > 0 ? 0.35 : 0
    for (const m of materials) {
      m.roughness = o.roughness ?? L.roughness
      m.metalness = o.metalness ?? 1
      m.specularIntensity = o.specularIntensity ?? 1
    }
    skin.uniforms(shared, L)
    for (const m of [front, back, letterFront, letterBack]) m.normalScale.set(L.height, L.height) // the maps bake a letter height as 1 % of the diameter (maps.js H_BAKE)
    for (const m of [front, back]) m.aoMapIntensity = L.cavity
    shared.uEdgeCalm.value = L.edgeCalm
    shared.uCeiling.value = L.ceiling
    shared.uKeepHue.value = L.keepHue ? 1 : 0
    shared.uSheen.value = L.sheen
    shared.uShadowRoom.value = L.shadows ? L.shadowRoom : 0
    let recompiled = false
    for (const m of [front, back]) recompiled = setParallax(m, L.parallax) || recompiled
    for (const m of materials) recompiled = setSkin(m, skin.n) || recompiled
    // clearcoat: the plastic's gloss, or the cost toggle. Only crossing zero recompiles
    const cc = o.clearcoat ?? (L.clearcoat ? 1 : 0)
    if (front.clearcoat > 0 !== cc > 0) recompiled = true
    for (const m of materials) {
      m.clearcoat = cc
      m.clearcoatRoughness = 0.06
    }
    group.scale.setScalar(Math.max(1, L.coinR))
    return recompiled
  }

  return {
    group,
    materials,
    uniforms: shared,
    /* how much of the studio the skin wants (lava, neon, matrix turn it down) */
    get envFactor() {
      return envFactor
    },
    shape,
    maps,
    letters,
    letterMesh,
    look,
    get geometry() {
      return geo
    },
    get triangles() {
      const count = (g) => (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3
      return [...meshes, ...Object.values(letterMesh)].reduce((s, m) => s + (m.visible ? count(m.geometry) : 0), 0)
    },
    get letterTriangles() {
      return Object.values(letterMesh).reduce((s, m) => s + (m.visible ? (m.geometry.attributes.position?.count ?? 0) / 3 : 0), 0)
    },
    dispose() {
      for (const m of [...meshes, ...Object.values(letterMesh)]) m.geometry.dispose()
      for (const m of materials) m.dispose()
      // the grain is every coin's (material.js): it stays for the next
    },
  }
}
