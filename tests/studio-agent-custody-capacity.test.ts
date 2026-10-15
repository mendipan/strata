import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { assertAgentWindowsCustody, WindowsExecutionCustodyError } from "../src/studio-agents/windows-custody.js";
import { windowsCustodyMaxPaths } from "../src/agent-adapters/windows-execution-custody-query.js";

// Metadata transport is modeled: no PowerShell/native ACL call or provider run.
// Actual traversal, identity comparison and descriptor refusal still execute.
test("modeled Windows custody covers a large nested cache and refuses an unsafe late entry", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "strata-custody-capacity-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^strata-custody-capacity-[A-Za-z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const nested = path.join(root, ...Array.from({ length: 10 }, (_, i) => "cache" + i));
  fs.mkdirSync(nested, { recursive: true });
  for (let i = 0; i < 1100; i++) fs.writeFileSync(path.join(nested, String(i).padStart(4, "0") + ".json"), "{}");
  const sid = "S-1-5-21-100-200-300-1001", unsafe = path.join(nested, "1099.json");
  const original = childProcess.execFile;
  let poison = false, truncate = false, calls = 0;
  const seen = new Set<string>();
  childProcess.execFile = ((_file: unknown, _args: unknown, _options: unknown, done: Function) => ({
    stdin: { on: () => {}, end: (input: string) => {
      const request = JSON.parse(input); calls++;
      assert.ok(request.paths.length > 0 && request.paths.length <= windowsCustodyMaxPaths);
      const items = request.paths.map((filename: string) => {
        seen.add(filename);
        const stat = fs.lstatSync(filename, { bigint: true }), directory = stat.isDirectory();
        return { requestedPath: filename, finalPath: "\\\\?\\" + filename,
          fileId: stat.ino.toString(16).padStart(16, "0"), volume: Number(stat.dev),
          attributes: directory ? 16 : 128, links: Number(stat.nlink), ownerSid: sid,
          revision: 1, control: directory ? 0x9004 : 0x8404, aclRevision: 2,
          aces: [{ type: 0, flags: directory ? 3 : 16, mask: 0x1f01ff,
            sid: poison && filename === unsafe ? "S-1-5-32-545" : sid, callback: false }] };
      });
      if (truncate) items.pop();
      queueMicrotask(() => done(null, Buffer.from(JSON.stringify({ version: 1, nonce: request.nonce, processSid: sid, items })), Buffer.alloc(0)));
    } },
  })) as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  await assertAgentWindowsCustody(root);
  assert.equal(seen.size, 1111);
  assert.equal(calls, Math.ceil(1111 / windowsCustodyMaxPaths));
  poison = true;
  await assert.rejects(assertAgentWindowsCustody(root), (e: unknown) => e instanceof WindowsExecutionCustodyError && e.reason === "access");
  poison = false; truncate = true;
  await assert.rejects(assertAgentWindowsCustody(root), (e: unknown) => e instanceof WindowsExecutionCustodyError && e.reason === "response");
  truncate = false;
  fs.mkdirSync(path.join(root, ...Array.from({ length: 17 }, (_, i) => "deep" + i)), { recursive: true });
  const before = calls;
  await assert.rejects(assertAgentWindowsCustody(root), (e: unknown) => e instanceof WindowsExecutionCustodyError && e.reason === "path");
  assert.equal(calls, before, "over-depth tree refuses before native queries");
});
