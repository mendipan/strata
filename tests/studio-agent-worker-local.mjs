import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
const keys = generateKeyPairSync("ed25519"),
  service = randomUUID(),
  token = "synthetic-private-token";
const options = convertV4MiniflareOptions({
  workers: [
    {
      name: "studio-agent-test",
      modules: true,
      script: await readFile("dist/studio-agent-worker/worker.mjs", "utf8"),
      compatibilityDate: "2026-10-08",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { AGENT: { className: "StudioAgent", useSQLite: true } },
      bindings: {
        RUNTIME_TOKEN: token,
        IDENTITY_PRIVATE_KEY: keys.privateKey
          .export({ type: "pkcs8", format: "der" })
          .toString("base64url"),
        SERVICE_ID: service,
        MODEL: "synthetic-model",
        BUNDLE_SHA256: "a".repeat(64),
      },
    },
  ],
  log: new Log(LogLevel.ERROR),
  cf: false,
});
options.telemetry = { enabled: false };
let external = 0;
options.workers[0].dev.outboundService = {
  type: "fetcher",
  handler: () => {
    external++;
    throw Error("External transport forbidden in local Worker qualification");
  },
};
const mf = new Miniflare(options);
const auth = { authorization: "Bearer " + token };
async function signed(response) {
  assert.equal(response.status, 200);
  const packet = await response.json();
  assert.ok(
    verify(
      null,
      Buffer.from(JSON.stringify(packet.payload)),
      keys.publicKey,
      Buffer.from(packet.signature, "base64url"),
    ),
  );
  return packet.payload;
}
try {
  assert.equal(
    (await mf.dispatchFetch("https://worker.test/identity")).status,
    403,
  );
  for (const pathname of [
    "/agents/StudioAgent/installation",
    "/rpc",
    "/partykit",
    "/turns/bad",
  ])
    assert.equal(
      (
        await mf.dispatchFetch("https://worker.test" + pathname, {
          headers: auth,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await mf.dispatchFetch("https://worker.test/identity", {
        headers: { ...auth, upgrade: "websocket" },
      })
    ).status,
    400,
  );
  const before = await signed(
    await mf.dispatchFetch("https://worker.test/identity", { headers: auth }),
  );
  assert.equal(before.initialized, false);
  assert.equal(before.service_id, service);
  const request = {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ service_id: service }),
  };
  assert.equal(
    (
      await signed(
        await mf.dispatchFetch("https://worker.test/initialize", request),
      )
    ).initialized,
    true,
  );
  assert.equal(
    (
      await signed(
        await mf.dispatchFetch("https://worker.test/initialize", request),
      )
    ).initialized,
    true,
  );
  const after = await signed(
    await mf.dispatchFetch("https://worker.test/identity", { headers: auth }),
  );
  assert.equal(after.initialized, true);
  assert.equal(after.model, "synthetic-model");
  assert.equal(
    (
      await mf.dispatchFetch("https://worker.test/identity?reset=1", {
        headers: auth,
      })
    ).status,
    400,
  );
  console.log(
    JSON.stringify({
      checks: [
        "auth before SDK routing",
        "blocked RPC/websocket paths",
        "metadata does not initialize",
        "explicit idempotent genesis",
        "independently verified identity",
      ],
      provider_requests: 0,
    }),
  );
} finally {
  await mf.dispose();
}
