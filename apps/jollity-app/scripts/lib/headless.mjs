// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A page in headless Chrome that works something out and hands it back: the
// one harness every bake script runs its page in.
//
//   const value = await runInChrome({ html, files, root, result: "__bake" })
//
// The page is served at `/`; `files` maps a path to its { body, type }; any
// other path is a file under `root` (when given), or a 404. The page sets
// `window[result]` when it is done, and that value comes back. The browser
// and the server are always torn down, whatever the page did.
import { createServer } from "node:http"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { chromium } from "playwright"

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".html": "text/html" }

export async function runInChrome({ html, files = {}, root, result, viewport, deviceScaleFactor, timeout = 180_000 }) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0])
    const served = url === "/" ? { body: html, type: "text/html" } : files[url]
    if (served) {
      res.writeHead(200, { "content-type": served.type })
      res.end(served.body)
      return
    }
    const file = root && path.join(root, url)
    if (!file || !file.startsWith(root) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" })
    res.end(readFileSync(file))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor })
    page.on("pageerror", (e) => console.error("page:", e.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForFunction((name) => window[name], result, { timeout })
    const value = await page.evaluate((name) => window[name], result)
    if (value && value.error) throw new Error(value.error)
    return value
  } finally {
    await browser.close()
    server.close()
  }
}
