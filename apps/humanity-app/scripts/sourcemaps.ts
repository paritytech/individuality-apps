// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

/** Uploads are opt-in; debug IDs are still injected without credentials. */
export function sentrySourceMaps(release: string): Plugin[] {
  const authToken = process.env["SENTRY_AUTH_TOKEN"]?.trim();
  const org = process.env["SENTRY_ORG"]?.trim();
  const project = process.env["SENTRY_PROJECT"]?.trim();
  const upload = Boolean(authToken && org && project);
  // The upload CLI has its own telemetry switch, separate from the plugin.
  if (upload) process.env["SENTRY_CLI_NO_TELEMETRY"] = "1";
  const mapPaths = Promise.withResolvers<string[]>();
  let outDir: string;

  return [
    ...sentryVitePlugin({
      authToken,
      org,
      project,
      telemetry: false,
      // Do not publish a new bundle whose maps failed to upload.
      errorHandler(error) {
        throw error;
      },
      // The SDK already receives this release through __APP_RELEASE__.
      // Debug IDs associate frames with maps independently of host URLs.
      release: {
        name: upload ? release : "",
        inject: false,
        create: false,
        finalize: false,
        setCommits: false,
        deploy: false,
      },
      sourcemaps: {
        disable: upload ? false : "disable-upload",
        filesToDeleteAfterUpload: mapPaths.promise,
      },
    }),
    {
      name: "humanity:remove-source-maps",
      apply: "build",
      configResolved(config) {
        outDir = resolve(config.root, config.build.outDir);
        mapPaths.resolve([`${outDir}/**/*.map`]);
      },
      closeBundle: {
        order: "post",
        sequential: true,
        async handler() {
          // Runs after Sentry's writeBundle/upload, even with uploads disabled.
          // Include copied public assets and fail the build on deletion errors.
          const files = await readdir(outDir, { recursive: true }).catch(
            (error: NodeJS.ErrnoException) => {
              // closeBundle also runs after an early bundler failure.
              if (error.code === "ENOENT") return [];
              throw error;
            },
          );
          await Promise.all(
            files.filter((file) => file.endsWith(".map")).map((file) => rm(resolve(outDir, file))),
          );
        },
      },
    },
  ];
}
