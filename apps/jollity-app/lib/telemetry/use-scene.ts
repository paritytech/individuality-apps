// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A SCREEN OWNS ITS SCENE: `useScene("chest")` samples the frames while the
 * screen is mounted (and `active`), and stops when it unmounts or turns
 * inactive, so the next screen is never recorded under this one's name. The
 * hook is the whole React side; the sampling is smoothness.ts (AGENTS.md
 * architecture rule 6).
 */
import { useEffect } from "react"
import { enterScene, leaveScene, setMoment, type MomentName, type SceneName } from "./smoothness"

const nothing = () => {}

/** The effect: enter `scene` when active, and return the leave. */
export function sceneEffect(scene: SceneName, active: boolean): () => void {
  if (!active) return nothing
  enterScene(scene)
  return () => leaveScene(scene)
}

export function useScene(scene: SceneName, active = true): void {
  useEffect(() => sceneEffect(scene, active), [scene, active])
}

/** Sets the moment on mount and on change, and clears it (null) on unmount. */
export function useMoment(moment: MomentName | null): void {
  useEffect(() => {
    setMoment(moment)
    return () => setMoment(null)
  }, [moment])
}
