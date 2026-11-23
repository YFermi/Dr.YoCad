import 'dotenv/config';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ZodError } from 'zod';
import { MAX_UPLOAD_BYTES } from '@cadline/shared';
import { prisma } from './lib/prisma.js';
import { connectRedis, redis } from './lib/redis.js';
import { STANDALONE, STANDALONE_DATA_DIR } from './lib/standalone.js';
import { seedStandaloneIfEmpty } from './lib/standaloneSeed.js';
import { ensureBucket, storage, storageHealthCheck } from './lib/storage.js';
import { registerSocketPlugin } from './plugins/socket.js';
import { aiRoutes } from './routes/ai.js';
import { annotationRoutes } from './routes/annotations.js';
import { authRoutes } from './routes/auth.js';
import { commentRoutes } from './routes/comments.js';
import { fileRoutes } from './routes/files.js';
import { localStorageRoutes } from './routes/localStorage.js';
import { measurementRoutes } from './routes/measurements.js';
import { projectRoutes } from './routes/projects.js';
import { shareRoutes } from './routes/share.js';
import {
  startConversionWorker,
  stopConversionWorker,
} from './workers/conversionWorker.js';

const PORT = Number(process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? '0.0.0.0';

async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
    bodyLimit: 60 * 1024 * 1024,
  });

  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    }
  );

  // Treat an empty body sent with Content-Type: application/json as "no body"
  // (Express/body-parser behavior) instead of 400 FST_ERR_CTP_EMPTY_JSON_BODY.
  // Bodyless POSTs such as /files/:id/presence/ping come from generic clients
  // that always set the header. Non-empty bodies use Fastify's default secure
  // JSON parser (prototype-poisoning protection unchanged).
  const defaultJsonParser = fastify.getDefaultJsonParser('error', 'error');
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      if (typeof body === 'string' && body.trim() === '') {
        done(null, undefined);
        return;
      }
      defaultJsonParser(request, body as string, done);
    }
  );

  await fastify.register(cors, {
    origin: process.env.WEB_URL ?? 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  });

  await fastify.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: '1 minute',
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? MAX_UPLOAD_BYTES),
      files: 1,
    },
  });

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Cadline Design Review API',
        description:
          'Session 3 API for auth, projects, chunked uploads, CAD conversion, 3D annotations, threaded comments, and persisted measurements.',
        version: '0.3.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
  });

  fastify.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues
            .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
            .join('; '),
        },
      });
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      fastify.log.error(error);
    }

    return reply.status(statusCode).send({
      success: false,
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message:
          statusCode >= 500 && process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred'
            : error.message,
      },
    });
  });

  // Liveness + dependency readiness. `/api/v1/health` is the path the web client,
  // scripts and CI use; `/health` is kept for existing probes. Returns 503 if the
  // database, Redis or object storage is unreachable.
  const healthHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok' as const;
      } catch {
        return 'down' as const;
      }
    };
    const [database, redisStatus, storage] = await Promise.all([
      check(() => prisma.$queryRaw`SELECT 1`),
      check(() => redis.ping()),
      check(() => storageHealthCheck()),
    ]);
    const checks = { database, redis: redisStatus, storage };
    const healthy = Object.values(checks).every((v) => v === 'ok');
    return reply.status(healthy ? 200 : 503).send({
      success: healthy,
      data: {
        status: healthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        checks,
      },
    });
  };
  fastify.get('/health', healthHandler);
  fastify.get('/api/v1/health', healthHandler);

  await fastify.register(authRoutes, { prefix: '/api/v1/auth' });
  await fastify.register(projectRoutes, { prefix: '/api/v1/projects' });
  await fastify.register(fileRoutes, { prefix: '/api/v1/files' });
  await fastify.register(shareRoutes, { prefix: '/api/v1/share' });
  await fastify.register(annotationRoutes, { prefix: '/api/v1' });
  await fastify.register(commentRoutes, { prefix: '/api/v1' });
  await fastify.register(measurementRoutes, { prefix: '/api/v1' });
  await fastify.register(aiRoutes, { prefix: '/api/v1/ai' });
  if (STANDALONE) {
    // Stand-ins for S3 presigned URLs (local disk storage); see STANDALONE.md.
    await fastify.register(localStorageRoutes, { prefix: '/api/v1/local-storage' });
  }

  registerSocketPlugin(fastify);

  fastify.addHook('onClose', async () => {
    stopConversionWorker();
  });

  return fastify;
}

async function start() {
  const fastify = await buildServer();

  try {
    await connectRedis();
    await ensureBucket();
    const seeded = STANDALONE ? await seedStandaloneIfEmpty(prisma, storage) : false;
    startConversionWorker();
    await fastify.listen({ port: PORT, host: HOST });
    if (STANDALONE) {
      console.log(
        `[standalone] API ready on http://localhost:${PORT} (data: ${STANDALONE_DATA_DIR}` +
          `${seeded ? ', demo data seeded' : ''})`
      );
    }
    fastify.log.info(`API listening on http://${HOST}:${PORT} (Swagger at /docs)`);
  } catch (err) {
    fastify.log.error(err);
    stopConversionWorker();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(1);
  }
}

void start();
