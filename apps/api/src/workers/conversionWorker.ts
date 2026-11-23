import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  convert2DFile,
  convertToGlb,
  is2DExtension,
} from '../lib/converter.js';

const POLL_INTERVAL_MS = 2000;

let pollTimer: NodeJS.Timeout | null = null;
let isProcessing = false;

async function processNextQueuedJob(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const job = await prisma.conversionJob.findFirst({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      include: {
        fileVersion: {
          include: {
            file: true,
          },
        },
      },
    });

    if (!job) {
      return;
    }

    // Atomically claim the job so overlapping runs cannot double-process
    const claimed = await prisma.conversionJob.updateMany({
      where: { id: job.id, status: 'QUEUED' },
      data: { status: 'RUNNING', error: null },
    });

    if (claimed.count === 0) {
      return;
    }

    const { fileVersion } = job;
    const inputKey = fileVersion.storageKey;
    const ext = path.extname(inputKey).replace('.', '').toLowerCase();

    console.log(
      `[conversion-worker] Started job=${job.id} file=${fileVersion.file.name} (v${fileVersion.versionNumber}) input=${inputKey}`
    );

    const startedAt = Date.now();

    // 2D Drawing branch (.dxf, .dwg, .pdf)
    if (is2DExtension(ext)) {
      const result = await convert2DFile(inputKey);
      const elapsedMs = Date.now() - startedAt;

      if (result.status === 'ready') {
        await prisma.$transaction([
          prisma.conversionJob.update({
            where: { id: job.id },
            data: {
              status: 'DONE',
              mode: result.mode,
              sceneKey: result.mode === '2D_DXF' ? result.sceneKey : null,
              layerManifest:
                result.mode === '2D_DXF'
                  ? (result.layers as unknown as Prisma.InputJsonValue)
                  : undefined,
              bounds:
                result.mode === '2D_DXF'
                  ? (result.bounds as unknown as Prisma.InputJsonValue)
                  : undefined,
              pageManifest:
                result.mode === '2D_PDF'
                  ? (result.pageManifest as unknown as Prisma.InputJsonValue)
                  : undefined,
              error: null,
            },
          }),
          prisma.fileVersion.update({
            where: { id: fileVersion.id },
            data: { status: 'READY' },
          }),
          prisma.file.update({
            where: { id: fileVersion.fileId },
            data: { status: 'READY' },
          }),
        ]);

        console.log(
          `[conversion-worker] Completed 2D job=${job.id} mode=${result.mode} in ${elapsedMs}ms`
        );
      } else {
        await prisma.$transaction([
          prisma.conversionJob.update({
            where: { id: job.id },
            data: {
              status: 'FAILED',
              mode: ext === 'pdf' ? '2D_PDF' : '2D_DXF',
              error: result.reason,
            },
          }),
          prisma.fileVersion.update({
            where: { id: fileVersion.id },
            data: { status: 'FAILED' },
          }),
          prisma.file.update({
            where: { id: fileVersion.fileId },
            data: { status: 'FAILED' },
          }),
        ]);

        console.error(
          `[conversion-worker] Failed 2D job=${job.id} after ${elapsedMs}ms reason="${result.reason}"`
        );
      }
      return;
    }

    // Existing 3D conversion behavior (unchanged)
    const baseKey = inputKey.slice(0, inputKey.length - path.extname(inputKey).length);
    const outputKey = `${baseKey}.converted.glb`;

    const result = await convertToGlb(inputKey, outputKey);
    const elapsedMs = Date.now() - startedAt;

    if (result.status === 'ready') {
      await prisma.$transaction([
        prisma.conversionJob.update({
          where: { id: job.id },
          data: {
            status: 'DONE',
            mode: '3D',
            glbStorageKey: result.glbKey,
            partTree: result.partTree as unknown as Prisma.InputJsonValue,
            error: null,
          },
        }),
        prisma.fileVersion.update({
          where: { id: fileVersion.id },
          data: { status: 'READY' },
        }),
        prisma.file.update({
          where: { id: fileVersion.fileId },
          data: { status: 'READY' },
        }),
      ]);

      console.log(
        `[conversion-worker] Completed job=${job.id} in ${elapsedMs}ms output=${result.glbKey} nodes=${result.partTree.length}`
      );
    } else {
      await prisma.$transaction([
        prisma.conversionJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            mode: '3D',
            error: result.reason,
          },
        }),
        prisma.fileVersion.update({
          where: { id: fileVersion.id },
          data: { status: 'FAILED' },
        }),
        prisma.file.update({
          where: { id: fileVersion.fileId },
          data: { status: 'FAILED' },
        }),
      ]);

      console.error(
        `[conversion-worker] Failed job=${job.id} after ${elapsedMs}ms reason="${result.reason}"`
      );
    }
  } catch (err) {
    console.error('[conversion-worker] Unexpected poll error:', err);
  } finally {
    isProcessing = false;
  }
}

export function startConversionWorker(): void {
  if (pollTimer) return;
  console.log(`[conversion-worker] Polling ConversionJob queue every ${POLL_INTERVAL_MS}ms`);
  pollTimer = setInterval(() => {
    void processNextQueuedJob();
  }, POLL_INTERVAL_MS);
  void processNextQueuedJob();
}

export function stopConversionWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[conversion-worker] Stopped');
  }
}
