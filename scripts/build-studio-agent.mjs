import { spawnSync } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/studio-agent-worker", { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--dry-run",
    "--metafile",
    "dist/studio-agent-worker/bundle-meta.json",
    "--config",
    "wrangler.studio-agent.jsonc",
    "--outdir",
    "dist/studio-agent-worker",
  ],
  { stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
if (result.status !== 0) throw new Error("Worker packaging failed.");
await copyFile(
  "dist/studio-agent-worker/worker.js",
  "dist/studio-agent-worker/worker.mjs",
);
