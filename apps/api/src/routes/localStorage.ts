/**
 * STANDALONE-only routes that stand in for S3 presigned URLs
 * (registered by server.ts only when STANDALONE=true):
 *
 *   PUT /api/v1/local-storage/parts/:uploadId/:partNumber?exp&sig  -> ETag header
 *   GET /api/v1/local-storage/objects?key&exp&sig                    -> object bytes
 *
 * Like S3, they authenticate by URL signature (lib/localStorage.ts), not by
 * Authorization header, and accept a raw body of any (or no) Content-Type.
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LocalStorageAdapter, verifyLocalUrl } from '../lib/localStorage.js';
import { storage } from '../lib/storage.js';

const signedQuery = z.object({
  exp: z.coerce.number().int(),
  sig: z.string().min(1),
});

const CONTENT_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
};

export async function localStorageRoutes(fastify: FastifyInstance): Promise<void> {
  if (!(storage instanceof LocalStorageAdapter)) {
    throw new Error('localStorageRoutes requires STANDALONE local storage');
  }
  const local = storage;

  // Chunks arrive as raw bytes like an S3 UploadPart: browsers send no
  // Content-Type, curl --data-binary sends x-www-form-urlencoded. Scoped to
  // this plugin only.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  const denied = {
    success: false,
    error: { code: 'SIGNATURE_INVALID', message: 'URL signature is invalid or expired' },
  } as const;

  fastify.put('/parts/:uploadId/:partNumber', async (request, reply) => {
    const params = z
      .object({ uploadId: z.string(), partNumber: z.coerce.number().int().min(1).max(10000) })
      .parse(request.params);
    const query = signedQuery.parse(request.query);
    if (!verifyLocalUrl(`part|${params.uploadId}|${params.partNumber}`, query.exp, query.sig)) {
      return reply.status(403).send(denied);
    }

    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const meta = await local.readUploadMeta(params.uploadId);
    const etag = await local.uploadMultipartChunk(
      meta.storageKey,
      params.uploadId,
      params.partNumber,
      body
    );
    return reply
      .header('ETag', `"${etag}"`)
      .header('Access-Control-Expose-Headers', 'ETag')
      .status(200)
      .send();
  });

  fastify.get('/objects', async (request, reply) => {
    const query = signedQuery.extend({ key: z.string().min(1) }).parse(request.query);
    if (!verifyLocalUrl(`get|${query.key}`, query.exp, query.sig)) {
      return reply.status(403).send(denied);
    }
    const object = await local.getObjectStream(query.key);
    reply.header(
      'Content-Type',
      CONTENT_TYPES[path.extname(query.key).toLowerCase()] ?? 'application/octet-stream'
    );
    if (object.contentLength !== undefined) reply.header('Content-Length', object.contentLength);
    return reply.send(object.body);
  });
}
