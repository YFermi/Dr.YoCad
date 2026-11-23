import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const S3_BUCKET = process.env.S3_BUCKET ?? 'cadline-files';

export const s3Client = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'cadline',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'cadline_dev_s3_secret',
  },
  // SDK default (WHEN_SUPPORTED) bakes a CRC32 of an *empty* body into presigned
  // UploadPart URLs, so every client PUT of real bytes fails with BadDigest.
  // Only add checksums when an operation requires them.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export async function ensureBucket(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  }
  await ensureBucketCors();
}

/**
 * Browser uploads PUT chunks straight to presigned part URLs and read the ETag
 * response header, which requires bucket CORS. Replaces the MinIO-only
 * scripts/setup-minio-cors.sh. Best-effort: some S3 implementations manage CORS
 * globally and reject PutBucketCors, which is not fatal.
 */
async function ensureBucketCors(): Promise<void> {
  const allowedOrigins = (process.env.WEB_URL ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  try {
    await s3Client.send(
      new PutBucketCorsCommand({
        Bucket: S3_BUCKET,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: allowedOrigins,
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      })
    );
  } catch (err) {
    console.warn(
      `[s3] Could not set bucket CORS (${err instanceof Error ? err.message : String(err)}); ` +
        'browser direct-to-S3 uploads may fail until CORS is configured on the storage server.'
    );
  }
}

export async function initMultipartUpload(
  storageKey: string,
  contentType: string
): Promise<string> {
  const response = await s3Client.send(
    new CreateMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
      ContentType: contentType,
    })
  );

  if (!response.UploadId) {
    throw new Error('Failed to initialize S3 multipart upload');
  }

  return response.UploadId;
}

export async function getPresignedPartUrl(
  storageKey: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds = 3600
): Promise<string> {
  const command = new UploadPartCommand({
    Bucket: S3_BUCKET,
    Key: storageKey,
    UploadId: uploadId,
    PartNumber: partNumber,
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

export async function getPresignedGetUrl(
  storageKey: string,
  expiresInSeconds = 900
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: storageKey,
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

export async function downloadObjectBuffer(storageKey: string): Promise<Buffer> {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
    })
  );

  if (!response.Body) {
    throw new Error(`Empty response body for S3 key: ${storageKey}`);
  }

  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/** Streams an object from storage (used by the binary asset proxy routes). */
export async function getObjectStream(storageKey: string): Promise<{
  body: NodeJS.ReadableStream;
  contentLength?: number;
}> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: storageKey })
  );
  if (!response.Body) {
    throw new Error(`Empty response body for S3 key: ${storageKey}`);
  }
  return {
    body: response.Body as NodeJS.ReadableStream,
    contentLength: response.ContentLength,
  };
}

export async function uploadObjectBuffer(
  storageKey: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
      Body: body,
      ContentType: contentType,
    })
  );
}

export async function uploadMultipartChunk(
  storageKey: string,
  uploadId: string,
  partNumber: number,
  body: Buffer
): Promise<string> {
  const response = await s3Client.send(
    new UploadPartCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
    })
  );

  if (!response.ETag) {
    throw new Error(`Missing ETag for uploaded part ${partNumber}`);
  }

  return response.ETag.replace(/"/g, '');
}

export async function completeMultipartUpload(
  storageKey: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>
): Promise<void> {
  const sortedParts = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((part) => ({
      PartNumber: part.partNumber,
      ETag: part.etag.startsWith('"') ? part.etag : `"${part.etag}"`,
    }));

  await s3Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sortedParts,
      },
    })
  );
}

export async function deleteStorageObject(storageKey: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
    })
  );
}
