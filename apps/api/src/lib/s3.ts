import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
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
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin123',
  },
});

export async function ensureBucket(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
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
