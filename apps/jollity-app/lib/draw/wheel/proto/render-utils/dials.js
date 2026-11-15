// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* the dial → config seam. A panel hands back a plain object of dial values;
   assign() writes the ones that are there onto a config table, through the
   name map that turns a dial's name into the table's terse key. Nothing here
   knows which table, or which scene. */

export function assign(target, src, map) {
  for (const [dial, key] of Object.entries(map)) {
    if (src[dial] != null) target[key] = num(src[dial])
  }
}

export function num(v) {
  return typeof v === 'number' ? v : Number(v)
}

/* ── the panel's folders ──────────────────────────────────────────────
 * DialKit gives a folder no memory of its own, so the open/closed state is
 * kept here: one localStorage entry per panel store, written back after any
 * folder header is clicked and React has painted. The names and which are open
 * to begin with are the panel's — nothing here knows a scene. */

const titleOf = (key) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()) // DialKit's own label: camelCase → Title Case

export function foldStore(key, folders, openByDefault = new Set()) {
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? {}
    } catch {
      return {}
    }
  })()
  document.addEventListener('click', (e) => {
    const header = e.target.closest?.('.dialkit-folder-header')
    if (!header || header.classList.contains('dialkit-panel-header')) return
    // after React has painted the toggle: read every folder's state and keep it
    requestAnimationFrame(() => {
      const open = { ...saved }
      for (const f of document.querySelectorAll('.dialkit-folder:not(.dialkit-folder-root)')) {
        const title = f.querySelector('.dialkit-folder-title')?.textContent
        const key = folders.find((k) => titleOf(k) === title)
        if (key) open[key] = f.getAttribute('data-open') === 'true'
      }
      try {
        localStorage.setItem(key, JSON.stringify(open))
      } catch {
        /* storage may be off: the defaults will do */
      }
    })
  })
  return (name) => ({ _collapsed: !(saved[name] ?? openByDefault.has(name)) })
}
