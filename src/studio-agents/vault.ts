import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, open, lstat } from "node:fs/promises";
import { z } from "zod";
import {
  privateDir,
  readPrivate,
  writePrivate,
} from "../explorer/owner-files.js";
import { noLinks } from "../node-state.js";
import { AgentHubError, uuid } from "./protocol.js";

const frame = z
  .object({
    format: z.literal("strata-agent-secret/1"),
    id: uuid,
    iv: z.string().max(64),
    tag: z.string().max(64),
    data: z.string().max(4096),
  })
  .strict();
export class AgentVault {
  constructor(
    readonly directory: string,
    readonly keyFile: string,
    private custody?: () => Promise<void>,
  ) {}
  async provision() {
    await this.custody?.();
    await privateDir(this.directory, true);
    await noLinks(this.keyFile);
    const f = await open(this.keyFile, "wx", 0o600);
    try {
      await f.writeFile(randomBytes(32));
      await f.sync();
    } finally {
      await f.close();
    }
  }
  private async key() {
    await this.custody?.();
    await privateDir(this.directory);
    await noLinks(this.keyFile);
    const stat = await lstat(this.keyFile);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new AgentHubError("AGENT_STATE_UNAVAILABLE", 503);
    const key = await readFile(this.keyFile);
    if (key.length !== 32)
      throw new AgentHubError("AGENT_STATE_UNAVAILABLE", 503);
    return key;
  }
  async check() {
    const key = await this.key();
    key.fill(0);
  }
  async save(id: string, value: string) {
    uuid.parse(id);
    const key = await this.key();
    try {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("strata-agent-secret/1:" + id));
      const data = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      await writePrivate(
        path.join(this.directory, id + ".json"),
        {
          format: "strata-agent-secret/1",
          id,
          iv: Buffer.from(iv).toString("base64url"),
          tag: Buffer.from(cipher.getAuthTag()).toString("base64url"),
          data: data.toString("base64url"),
        },
        true,
      );
    } finally {
      key.fill(0);
    }
  }
  async use<T>(id: string, work: (value: string) => Promise<T>) {
    uuid.parse(id);
    const key = await this.key();
    let plain: Buffer | undefined;
    try {
      const f = frame.parse(
        await readPrivate(path.join(this.directory, id + ".json"), 8192),
      );
      if (f.id !== id) throw new AgentHubError("AGENT_AUTH", 403);
      const d = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(f.iv, "base64url"),
      );
      d.setAAD(Buffer.from(f.format + ":" + id));
      d.setAuthTag(Buffer.from(f.tag, "base64url"));
      plain = Buffer.concat([
        d.update(Buffer.from(f.data, "base64url")),
        d.final(),
      ]);
      return await work(Buffer.from(plain!).toString("utf8"));
    } catch (e) {
      if (e instanceof AgentHubError) throw e;
      throw new AgentHubError("AGENT_AUTH", 403);
    } finally {
      plain?.fill(0);
      key.fill(0);
    }
  }
}
