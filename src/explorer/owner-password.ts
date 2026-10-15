import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { problem } from './contract.js';

export const verifierSchema = z.object({ format: z.literal('strata-owner-password/1'), algorithm: z.literal('scrypt'), N: z.literal(32768), r: z.literal(8), p: z.literal(3), salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/), hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type PasswordVerifier = z.infer<typeof verifierSchema>;
const blocked = new Set(['passwordpassword','password123456789','123456789012345','qwertyuiopasdfgh','letmeinletmeinletmein','stratastudiopassword']);
export function ownerName(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9._-]{3,32}$/.test(input)) problem('INVALID_INPUT',400,'Use 3–32 letters, digits, dots, underscores or hyphens for your sign-in name.');
  return input.toLowerCase();
}
export function ownerPassword(input: unknown, username = ''): string {
  if (typeof input !== 'string') problem('INVALID_INPUT',400,'Enter a password.');
  const value = input.normalize('NFC'), count = [...value].length;
  if (count < 15 || count > 128 || Buffer.byteLength(value) > 512 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || blocked.has(value.toLowerCase()) || (username && value.toLowerCase().includes(username) && new Set(value.toLowerCase().replaceAll(username,'')).size < 4)) problem('INVALID_INPUT',400,'Use a less common password of 15–128 characters, without control characters.');
  return value;
}
export class PasswordWork {
  private active = false;
  private queue: (() => void)[] = [];
  private async derive(value: string, salt: Uint8Array) {
    if (this.active) {
      if (this.queue.length >= 2) problem('OWNER_BUSY',429,'Password verification is busy. Try again shortly.');
      await new Promise<void>(resolve => this.queue.push(resolve));
    } else this.active = true;
    try { return await new Promise<Buffer>((resolve,reject) => scrypt(value, salt, 32, { N:32768,r:8,p:3,maxmem:64*1024*1024 }, (error,key) => error ? reject(error) : resolve(key))); }
    finally { const next = this.queue.shift(); if (next) next(); else this.active = false; }
  }
  async create(value: string): Promise<PasswordVerifier> {
    const salt = randomBytes(16), result = await this.derive(value,salt);
    try { return {format:'strata-owner-password/1',algorithm:'scrypt',N:32768,r:8,p:3,salt:Buffer.from(salt).toString('base64url'),hash:Buffer.from(result).toString('base64url')}; } finally { result.fill(0); }
  }
  async verify(input: unknown, verifier: PasswordVerifier): Promise<boolean> {
    const valid = typeof input === 'string' && Buffer.byteLength(input) <= 512;
    const result = await this.derive(valid ? input.normalize('NFC') : '', Buffer.from(verifier.salt,'base64url'));
    try { return valid && timingSafeEqual(result,Buffer.from(verifier.hash,'base64url')); } finally { result.fill(0); }
  }
}
