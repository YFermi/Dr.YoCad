import 'dotenv/config';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
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
import { ensureBucket, s3Client, S3_BUCKET } from './lib/s3.js';
import { registerSocketPlugin } from './plugins/socket.js';
import { aiRoutes } from './routes/ai.js';
import { annotationRoutes } from './routes/annotations.js';
import { authRoutes } from './routes/auth.js';
import { commentRoutes } from './routes/comments.js';
import { fileRoutes } from './routes/files.js';
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
  // scripts and CI use (same as the former mock server); `/health` is kept for
  // existing probes. Returns 503 if Postgres, Redis or the S3 bucket is unreachable.
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
      check(() => s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))),
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
    startConversionWorker();
    await fastify.listen({ port: PORT, host: HOST });
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
