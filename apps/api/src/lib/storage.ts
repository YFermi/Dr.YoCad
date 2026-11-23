/**
 * Object storage used by routes, the converter and the seed.
 *
 * Default (production): S3Adapter, a thin wrapper over the unchanged functions
 * in lib/s3.ts. STANDALONE=true: LocalStorageAdapter (lib/localStorage.ts),
 * which keeps objects on disk under ./data/files and serves "presigned" URLs
 * through signed API routes (routes/localStorage.ts).
 */
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import * as s3 from './s3.js';
import { LocalStorageAdapter } from './localStorage.js';
import { STANDALONE } from './standalone.js';

export interface StorageAdapter {
  ensureBucket(): Promise<void>;
  /** Throws when storage is unreachable (used by /health). */
  healthCheck(): Promise<void>;
  initMultipartUpload(storageKey: string, contentType: string): Promise<string>;
  getPresignedPartUrl(
    storageKey: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number
  ): Promise<string>;
  getPresignedGetUrl(storageKey: string, expiresInSeconds?: number): Promise<string>;
  downloadObjectBuffer(storageKey: string): Promise<Buffer>;
  getObjectStream(
    storageKey: string
  ): Promise<{ body: NodeJS.ReadableStream; contentLength?: number }>;
  uploadObjectBuffer(
    storageKey: string,
    body: Buffer | Uint8Array,
    contentType: string
  ): Promise<void>;
  uploadMultipartChunk(
    storageKey: string,
    uploadId: string,
    partNumber: number,
    body: Buffer
  ): Promise<string>;
  completeMultipartUpload(
    storageKey: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void>;
  deleteStorageObject(storageKey: string): Promise<void>;
}

export const S3Adapter: StorageAdapter = {
  ensureBucket: s3.ensureBucket,
  healthCheck: async () => {
    await s3.s3Client.send(new HeadBucketCommand({ Bucket: s3.S3_BUCKET }));
  },
  initMultipartUpload: s3.initMultipartUpload,
  getPresignedPartUrl: s3.getPresignedPartUrl,
  getPresignedGetUrl: s3.getPresignedGetUrl,
  downloadObjectBuffer: s3.downloadObjectBuffer,
  getObjectStream: s3.getObjectStream,
  uploadObjectBuffer: s3.uploadObjectBuffer,
  uploadMultipartChunk: s3.uploadMultipartChunk,
  completeMultipartUpload: s3.completeMultipartUpload,
  deleteStorageObject: s3.deleteStorageObject,
};

export const storage: StorageAdapter = STANDALONE ? new LocalStorageAdapter() : S3Adapter;

// Function exports with the same names/signatures as lib/s3.ts, so call sites
// only change their import path.
export const ensureBucket: StorageAdapter['ensureBucket'] = () => storage.ensureBucket();
export const storageHealthCheck: StorageAdapter['healthCheck'] = () => storage.healthCheck();
export const initMultipartUpload: StorageAdapter['initMultipartUpload'] = (...args) =>
  storage.initMultipartUpload(...args);
export const getPresignedPartUrl: StorageAdapter['getPresignedPartUrl'] = (...args) =>
  storage.getPresignedPartUrl(...args);
export const getPresignedGetUrl: StorageAdapter['getPresignedGetUrl'] = (...args) =>
  storage.getPresignedGetUrl(...args);
export const downloadObjectBuffer: StorageAdapter['downloadObjectBuffer'] = (...args) =>
  storage.downloadObjectBuffer(...args);
export const getObjectStream: StorageAdapter['getObjectStream'] = (...args) =>
  storage.getObjectStream(...args);
export const uploadObjectBuffer: StorageAdapter['uploadObjectBuffer'] = (...args) =>
  storage.uploadObjectBuffer(...args);
export const uploadMultipartChunk: StorageAdapter['uploadMultipartChunk'] = (...args) =>
  storage.uploadMultipartChunk(...args);
export const completeMultipartUpload: StorageAdapter['completeMultipartUpload'] = (...args) =>
  storage.completeMultipartUpload(...args);
export const deleteStorageObject: StorageAdapter['deleteStorageObject'] = (...args) =>
  storage.deleteStorageObject(...args);
