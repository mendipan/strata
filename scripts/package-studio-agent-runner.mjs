import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
await mkdir("dist/studio-agent-runner", { recursive: true });
const bundle = await build({
  entryPoints: ["scripts/studio-agent-runner.ts"],
  outfile: "dist/studio-agent-runner/studio-agent-runner.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  metafile: true,
});
await writeFile("dist/studio-agent-runner/bundle-meta.json", JSON.stringify(bundle.metafile, null, 2) + "\n");
const files = [
  [
    "studio-agent-runner.js",
    await readFile("dist/studio-agent-runner/studio-agent-runner.js"),
  ],
  ...await Promise.all(["licenses/babel-parser-8.0.6-LICENSE", "licenses/bundle-evidence.json", "licenses/claude-sdk-evidence.json", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "licenses/BUNDLED_LICENSES.txt", "licenses/runner-dependencies.json", "licenses/claude-agent-sdk-0.3.296-LICENSE.md"].map(async name => [name, await readFile(name)])),
  ["Install.ps1", await readFile("deploy/studio-agent-runner/Install.ps1")],
  ["README.md", await readFile("deploy/studio-agent-runner/README.md")],
  ["package.json", await readFile("deploy/studio-agent-runner/package.json")],
  [
    "package-lock.json",
    await readFile("deploy/studio-agent-runner/package-lock.json"),
  ],
];
const { createHash } = await import("node:crypto");
const zod = JSON.parse(await readFile("node_modules/zod/package.json", "utf8"));
const manifest = { format: "strata-studio-runner-package/1", bundled_dependencies: [{ name: zod.name, version: zod.version, license: zod.license }],
  optional_sdk_bundled: false, files: files.map(([name, data]) => ({ path: name, bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex") })).sort((a,b) => a.path.localeCompare(b.path)) };
files.push(["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")]);
function crc(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
const local = [],
  central = [];
let offset = 0;
for (const [name, data] of files) {
  const filename = Buffer.from(name),
    compressed = deflateRawSync(data),
    check = crc(data),
    head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(8, 8);
  head.writeUInt32LE(check, 14);
  head.writeUInt32LE(compressed.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(filename.length, 26);
  local.push(head, filename, compressed);
  const center = Buffer.alloc(46);
  center.writeUInt32LE(0x02014b50);
  center.writeUInt16LE(20, 4);
  center.writeUInt16LE(20, 6);
  center.writeUInt16LE(8, 10);
  center.writeUInt32LE(check, 16);
  center.writeUInt32LE(compressed.length, 20);
  center.writeUInt32LE(data.length, 24);
  center.writeUInt16LE(filename.length, 28);
  center.writeUInt32LE(offset, 42);
  central.push(center, filename);
  offset += head.length + filename.length + compressed.length;
}
const centralBytes = Buffer.concat(central),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBytes.length, 12);
end.writeUInt32LE(offset, 16);
await writeFile(
  "dist/studio-agent-runner.zip",
  Buffer.concat([...local, centralBytes, end]),
);
