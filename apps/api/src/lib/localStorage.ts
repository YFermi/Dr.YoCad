/**
 * STANDALONE object storage on the local filesystem (<repo>/data/files).
 * Implements the same StorageAdapter interface as the S3 adapter:
 *
 *  - objects:   data/files/<storageKey>          (storage keys use '/' segments)
 *  - multipart: data/files/.multipart/<uploadId>/{meta.json,<partNumber>}
 *  - "presigned" part/GET URLs point at signed API routes
 *    (routes/localStorage.ts), so the browser upload flow (PUT each chunk to
 *    its URL, read the ETag header, then /files/:id/complete) is unchanged.
 */
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StorageAdapter } from './storage.js';
import { STANDALONE_FILES_DIR } from './standalone.js';

const MULTIPART_DIR = '.multipart';
// Per-process signing key: outstanding upload/download URLs stop working after
// an API restart, like expired presigned URLs.
const SIGNING_KEY = crypto.randomBytes(32);

export function localPublicApiUrl(): string {
  return (
    process.env.STANDALONE_PUBLIC_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`
  ).replace(/\/$/, '');
}

export function signLocalUrl(purpose: string, exp: number): string {
  return crypto
    .createHmac('sha256', SIGNING_KEY)
    .update(`cadline-local-v1|${purpose}|${exp}`)
    .digest('base64url');
}

export function verifyLocalUrl(purpose: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signLocalUrl(purpose, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function md5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly root: string = STANDALONE_FILES_DIR) {}

  /** Maps a storage key to a path inside root; rejects traversal. */
  resolveKey(storageKey: string): string {
    const segments = storageKey.split('/');
    if (
      !storageKey ||
      storageKey.includes('\0') ||
      storageKey.includes('\\') ||
      segments.some((s) => s === '' || s === '.' || s === '..') ||
      segments[0] === MULTIPART_DIR
    ) {
      throw new Error(`Invalid storage key: ${storageKey}`);
    }
    const resolved = path.resolve(this.root, ...segments);
    if (!resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Invalid storage key: ${storageKey}`);
    }
    return resolved;
  }

  private uploadDir(uploadId: string): string {
    if (!/^local-[0-9a-f-]{36}$/.test(uploadId)) {
      throw new Error(`Invalid upload id: ${uploadId}`);
    }
    return path.join(this.root, MULTIPART_DIR, uploadId);
  }

  async readUploadMeta(uploadId: string): Promise<{ storageKey: string; contentType: string }> {
    const raw = await fs.readFile(path.join(this.uploadDir(uploadId), 'meta.json'), 'utf8');
    return JSON.parse(raw) as { storageKey: string; contentType: string };
  }

  private async writeAtomic(target: string, body: Buffer | Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, target);
  }

  async ensureBucket(): Promise<void> {
    await fs.mkdir(path.join(this.root, MULTIPART_DIR), { recursive: true });
  }

  async healthCheck(): Promise<void> {
    await fs.access(this.root, fs.constants.W_OK);
  }

  async initMultipartUpload(storageKey: string, contentType: string): Promise<string> {
    this.resolveKey(storageKey);
    const uploadId = `local-${crypto.randomUUID()}`;
    const dir = this.uploadDir(uploadId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ storageKey, contentType }));
    return uploadId;
  }

  async getPresignedPartUrl(
    _storageKey: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = 3600
  ): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = signLocalUrl(`part|${uploadId}|${partNumber}`, exp);
    return `${localPublicApiUrl()}/api/v1/local-storage/parts/${uploadId}/${partNumber}?exp=${exp}&sig=${sig}`;
  }

  async getPresignedGetUrl(storageKey: string, expiresInSeconds = 900): Promise<string> {
    this.resolveKey(storageKey);
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = signLocalUrl(`get|${storageKey}`, exp);
    return `${localPublicApiUrl()}/api/v1/local-storage/objects?key=${encodeURIComponent(storageKey)}&exp=${exp}&sig=${sig}`;
  }

  async downloadObjectBuffer(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.resolveKey(storageKey));
  }

  async getObjectStream(
    storageKey: string
  ): Promise<{ body: NodeJS.ReadableStream; contentLength?: number }> {
    const file = this.resolveKey(storageKey);
    const stat = await fs.stat(file);
    return { body: createReadStream(file), contentLength: stat.size };
  }

  async uploadObjectBuffer(
    storageKey: string,
    body: Buffer | Uint8Array,
    _contentType: string
  ): Promise<void> {
    await this.writeAtomic(this.resolveKey(storageKey), body);
  }

  async uploadMultipartChunk(
    storageKey: string,
    uploadId: string,
    partNumber: number,
    body: Buffer
  ): Promise<string> {
    const meta = await this.readUploadMeta(uploadId);
    if (meta.storageKey !== storageKey) {
      throw new Error(`Upload ${uploadId} does not belong to ${storageKey}`);
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      throw new Error(`Invalid part number: ${partNumber}`);
    }
    await this.writeAtomic(path.join(this.uploadDir(uploadId), String(partNumber)), body);
    return md5(body);
  }

  async completeMultipartUpload(
    storageKey: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void> {
    const meta = await this.readUploadMeta(uploadId);
    if (meta.storageKey !== storageKey) {
      throw new Error(`Upload ${uploadId} does not belong to ${storageKey}`);
    }
    const dir = this.uploadDir(uploadId);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const buffers: Buffer[] = [];
    for (const part of ordered) {
      const buffer = await fs.readFile(path.join(dir, String(part.partNumber)));
      // Same check S3 does: the client must echo each part's ETag.
      if (md5(buffer) !== part.etag.replace(/"/g, '')) {
        throw Object.assign(new Error(`ETag mismatch for part ${part.partNumber}`), {
          statusCode: 400,
          code: 'INVALID_PART',
        });
      }
      buffers.push(buffer);
    }
    await this.writeAtomic(this.resolveKey(storageKey), Buffer.concat(buffers));
    await fs.rm(dir, { recursive: true, force: true });
  }

  async deleteStorageObject(storageKey: string): Promise<void> {
    await fs.rm(this.resolveKey(storageKey), { force: true });
  }
}
