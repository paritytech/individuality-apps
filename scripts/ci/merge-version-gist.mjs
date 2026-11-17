// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Publishes this leg's APP_VERSION and build time into the public version gist,
// which is how a running app learns a newer build is out
// (apps/jollity-app/lib/release/stale-build.ts).
//
// The gist file GIST_FILE holds one key per leg, each
// { "version": "<APP_VERSION>", "time": <commit time, unix seconds> }. Each leg
// reads the file, sets only its own key and PATCHes it back, so the legs never
// overwrite one another. Env: GIST_ID (the repo variable VERSION_GIST_ID),
// GIST_TOKEN (the secret GIST_TOKEN), GIST_FILE, KEY (the name served),
// VERSION, TIME.
//
// An API failure is a warning and exit 0: telling players about a release must
// never fail the deploy that made it.

export function mergeVersionDoc(existing, key, version, time, updated) {
  let doc = {}
  try {
    const parsed = JSON.parse(existing)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed
  } catch {
    /* an empty or damaged file starts over */
  }
  return JSON.stringify({ ...doc, [key]: { version, time }, updated }, null, 2)
}

export async function publishVersion(env, fetchImpl = fetch, now = () => new Date().toISOString()) {
  const { GIST_ID, GIST_TOKEN, GIST_FILE, KEY, VERSION, TIME } = env
  const time = Number(TIME)
  // no readable time, no entry: the order is the point of it
  if (!GIST_ID || !GIST_TOKEN || !GIST_FILE || !KEY || !VERSION || !TIME || !Number.isFinite(time)) return "skipped"
  const url = `https://api.github.com/gists/${GIST_ID}`
  const headers = {
    Authorization: `Bearer ${GIST_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  try {
    const read = await fetchImpl(url, { headers })
    if (!read.ok) return "failed"
    const gist = await read.json()
    const merged = mergeVersionDoc(gist?.files?.[GIST_FILE]?.content ?? "", KEY, VERSION, time, now())
    const write = await fetchImpl(url, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ files: { [GIST_FILE]: { content: merged } } }),
    })
    return write.ok ? "written" : "failed"
  } catch {
    return "failed"
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await publishVersion(process.env)
  if (result === "skipped") {
    console.log("::notice title=Version gist not updated::Nothing to write: the gist id, token, file, name, version or time is empty.")
  } else if (result === "failed") {
    console.log("::warning title=Version gist not updated::The gist could not be read or written; the deploy is unaffected.")
  } else {
    console.log(`Version gist updated: ${process.env.KEY} = ${process.env.VERSION} @ ${process.env.TIME}`)
  }
}
