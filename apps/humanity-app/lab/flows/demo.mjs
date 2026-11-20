#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Cut the current night's humanity-dim2 actor videos after teardown; never start the journey.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const safe = (id) => {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) throw new Error(`Unsafe recording/actor id: ${id}`);
  return id;
};

/** The app-owned record written by `recording.ts`. Product-lab 0.1.2 may also save its own recording of this feature
 * in the same folder; the demo cuts only the app's measured record, so one run gives exactly three actor demos. */
export const FLOW_RECORDING_ID = "humanity-dim2-custom-flow";

/** Explicit ids only, including failed attempts; never let demo select an older passed recording. */
export function selectDemos(recordings, { failed = false, journeyStatus } = {}) {
  return recordings.filter((data) => data.id === FLOW_RECORDING_ID && data.kind === "feature" && /(?:^|\/)lab\/flows\/humanity-dim2(?:-wrong-credits)?\.feature$/.test(data.feature?.uri ?? ""))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    .flatMap((data) => {
      safe(data.id);
      const videos = data.capture?.videos ?? [];
      // A headless test has actor pages, not a lab-window video. Preserve every page of each actor.
      const ids = [...new Set(videos.map((video) => video.actor).filter(Boolean))];
      if (!ids.length) throw new Error(`${data.id}: no actor videos; see capture.videoProblems and raw videos`);
      const missing = data.actors.filter((actor) => !ids.includes(actor.id));
      if (missing.length) throw new Error(`${data.id}: missing actor videos for ${missing.map((actor) => actor.role ?? actor.name ?? actor.id).join(", ")}`);
      return ids.map((id) => {
        safe(id);
        const actor = data.actors.find((actor) => actor.id === id);
        const role = actor?.role ?? actor?.name ?? data.steps.find((step) => step.actor === id && step.role)?.role;
        if (!role) throw new Error(`${data.id}: no role/name for actor ${id}`);
        const streams = videos.filter((video) => video.actor === id).sort((a, b) => a.openedAt - b.openedAt);
        for (const video of streams) if (!/^videos\/[A-Za-z0-9@._-]+$/.test(video.file)) throw new Error(`Unsafe video path: ${video.file}`);
        return { id: data.id, actor: id, role, data, streams,
          failed: failed || journeyStatus !== "passed" || data.status !== "passed" };
      });
    });
}

/** One continuous actor timeline: Humanity, then DIM2, cut at the next page opening. The last page runs past the last
 * step to its measured close, when there is one: product-lab 0.1.2 holds a step's still only inside the video. */
export function videoSegments(job) {
  return job.streams.map((video, index) => {
    const start = Math.max(video.openedAt, job.data.startedAt);
    const next = job.streams[index + 1]?.openedAt;
    const tail = Number.isFinite(video.closedAt) && video.closedAt > job.data.finishedAt ? video.closedAt : job.data.finishedAt;
    const end = next === undefined ? tail : Math.min(next, job.data.finishedAt);
    if (![start, end, video.openedAt].every(Number.isFinite)) throw new Error(`${job.id}: invalid video times`);
    return { file: video.file, start, end, offsetMs: start - video.openedAt, durationMs: end - start };
  }).filter((segment) => segment.durationMs > 0);
}

export function demoArgs(job, out, { plan = false } = {}) {
  return ["demo", job.id, "--config", "lab.flow.config.ts", "--actor", job.role,
    "--out", out, "--max-seconds", "60", "--json", ...(job.failed ? ["--failed"] : []), ...(plan ? ["--plan"] : [])];
}

export function derivedRecording(job, openedAt, closedAt) {
  return { ...job.data,
    // --failed permits a failed recording; it does not mark a passed recording as failed. Only the edit copy changes.
    ...(job.failed && job.data.status === "passed" ? { status: "failed", error: "The CI night or journey did not pass; this is diagnostic footage, not a passing run." } : {}),
    capture: { ...job.data.capture, videos: [{ actor: job.actor, file: "videos/actor.mp4", mediaType: "video/mp4", source: "headless-page", openedAt, ...(closedAt === undefined ? {} : { closedAt }) }] } };
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} failed (${result.status}): ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export function cutDemos({ runsDir, out, workDir, failed = false, plan = false }, run = command) {
  mkdirSync(out, { recursive: true });
  const report = { demos: [], errors: [], skipped: [] };
  const nights = existsSync(runsDir) ? ["current"] : [];
  for (const night of nights) {
    const directory = runsDir;
    if (!existsSync(directory)) { report.skipped.push(`${night}: no humanity-dim2 recordings (journey not reached or not selected)`); continue; }
    try {
      const journeyStatus = failed ? "failed" : "passed";
      const recordings = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => join(directory, entry.name, "recording.json")).filter(existsSync).map(read);
      const jobs = selectDemos(recordings, { failed, journeyStatus });
      if (!jobs.length) report.errors.push(`${night}: no humanity-dim2 feature recording; raw videos retained if present`);
      for (const job of jobs) {
        const target = join(out, night, job.id, job.actor);
        mkdirSync(target, { recursive: true });
        try {
          const segments = videoSegments(job);
          if (!segments.length) throw new Error("No video overlaps the scenario");
          const store = join(workDir, night, job.id, job.actor);
          mkdirSync(join(store, "videos"), { recursive: true });
          mkdirSync(join(store, job.id), { recursive: true });
          writeFileSync(join(target, "sources.json"), JSON.stringify({ recording: job.id, actor: job.role, failed: job.failed, segments }, null, 2) + "\n");
          const parts = segments.map((segment, index) => {
            const source = join(directory, segment.file);
            if (!existsSync(source)) throw new Error(`Missing raw video ${source}`);
            const duration = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", source]).trim()) * 1000;
            if (!Number.isFinite(duration) || duration <= segment.offsetMs || duration + 1000 < segment.offsetMs + segment.durationMs)
              throw new Error(`Truncated video ${segment.file}: ${duration} ms cannot cover the requested interval`);
            const part = join(store, `part-${index}.mp4`);
            // Bound CPU use; normalize resolution/fps before concatenating concurrent app pages.
            run("ffmpeg", ["-v", "error", "-y", "-ss", String(segment.offsetMs / 1000), "-i", source,
              "-t", String(segment.durationMs / 1000), "-an", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25",
              "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", part]);
            return part;
          });
          // Relative generated basenames only, so concat's file syntax never sees user paths.
          writeFileSync(join(store, "parts.txt"), parts.map((_, index) => `file 'part-${index}.mp4'`).join("\n") + "\n");
          run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", join(store, "parts.txt"), "-c", "copy", join(store, "videos/actor.mp4")]);
          writeFileSync(join(store, job.id, "recording.json"), JSON.stringify(derivedRecording(job, segments[0].start, segments[0].start + segments.reduce((total, segment) => total + segment.durationMs, 0)), null, 2) + "\n");
          const output = run("node", [join(root, "node_modules/@parity/product-lab/entrypoints/cli/bin/product-lab.mjs"), ...demoArgs(job, target, { plan })],
            { cwd: join(root, "apps/humanity-app"), env: { ...process.env, PRODUCT_LAB_RECORDINGS_DIR: store, PRODUCT_LAB_RECORDINGS: "frames" } });
          writeFileSync(join(target, "command-report.json"), output);
          report.demos.push({ recording: job.id, actor: job.role, failed: job.failed, out: target });
        } catch (error) { report.errors.push(`${night}/${job.id}/${job.role}: ${error.message}`); }
      }
    } catch (error) { report.errors.push(`${night}: ${error.message}`); }
  }
  writeFileSync(join(out, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "runs-dir": { type: "string", default: "runs" }, out: { type: "string", default: "artifacts/humanity-dim2-demo" },
    "work-dir": { type: "string", default: "artifacts/humanity-dim2-edit" }, failed: { type: "boolean", default: false }, plan: { type: "boolean", default: false } } });
  const report = cutDemos({ runsDir: resolve(values["runs-dir"]), out: resolve(values.out), workDir: resolve(values["work-dir"]), failed: values.failed, plan: values.plan });
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}
