import path from 'node:path';
import type {
  DxfBounds,
  DxfLayerManifestItem,
  PartNode,
  PdfPageManifest,
} from '@cadline/shared';
import { downloadObjectBuffer, uploadObjectBuffer } from './s3.js';
import {
  DWG_UNSUPPORTED_REASON,
  is2DExtension,
  parseDxfBufferToScene,
  rasterizePdfBufferToPngPages,
} from './converter2d.js';
import { convertUploadedBuffer } from './proceduralGlb.js';

export { DWG_UNSUPPORTED_REASON, is2DExtension };

export type Conversion3DResult =
  | { status: 'ready'; glbKey: string; partTree: PartNode[] }
  | { status: 'failed'; reason: string };

export type Conversion2DResult =
  | {
      status: 'ready';
      mode: '2D_DXF';
      sceneKey: string;
      layers: DxfLayerManifestItem[];
      bounds: DxfBounds;
    }
  | {
      status: 'ready';
      mode: '2D_PDF';
      pageManifest: PdfPageManifest;
      manifestKey: string;
    }
  | { status: 'failed'; reason: string };

/**
 * 3D conversion pipeline (OpenCASCADE WASM worker for STEP/IGES/BREP, plus STL/OBJ/GLB/GLTF).
 */
export async function convertToGlb(
  inputKey: string,
  outputKey: string
): Promise<Conversion3DResult> {
  try {
    const rawBuffer = await downloadObjectBuffer(inputKey);
    const artifact = await convertUploadedBuffer(rawBuffer, path.basename(inputKey));
    await uploadObjectBuffer(outputKey, Buffer.from(artifact.glbBuffer), 'model/gltf-binary');
    return { status: 'ready', glbKey: outputKey, partTree: artifact.partTree };
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : 'Unexpected 3D conversion error',
    };
  }
}

/**
 * 2D drawing conversion branch (Session 4 — A2):
 * - .dxf -> parse with dxf-parser, serialize compact scene graph JSON to <source>.dxf.json
 * - .pdf -> rasterize pages with pdfjs-dist at 2x scale to <source>.page-<n>.png + manifest JSON
 * - .dwg -> deliberate unsupported proprietary format failure message
 */
export async function convert2DFile(inputKey: string): Promise<Conversion2DResult> {
  const ext = path.extname(inputKey).replace('.', '').toLowerCase();

  if (ext === 'dwg') {
    return {
      status: 'failed',
      reason: DWG_UNSUPPORTED_REASON,
    };
  }

  try {
    const rawBuffer = await downloadObjectBuffer(inputKey);

    if (ext === 'dxf') {
      const { scene, layers, bounds } = parseDxfBufferToScene(rawBuffer);
      const sceneKey = `${inputKey}.dxf.json`;
      const sceneJson = Buffer.from(JSON.stringify(scene), 'utf8');
      await uploadObjectBuffer(sceneKey, sceneJson, 'application/json');

      return {
        status: 'ready',
        mode: '2D_DXF',
        sceneKey,
        layers,
        bounds,
      };
    }

    if (ext === 'pdf') {
      const rasterized = await rasterizePdfBufferToPngPages(rawBuffer, 2);
      const pageKeys: string[] = [];

      for (const page of rasterized.pages) {
        const pageKey = `${inputKey}.page-${page.pageNumber}.png`;
        await uploadObjectBuffer(pageKey, page.png, 'image/png');
        pageKeys.push(pageKey);
      }

      const pageManifest: PdfPageManifest = {
        pageCount: rasterized.pageCount,
        pageSize: rasterized.pageSize,
        pageKeys,
      };

      const manifestKey = `${inputKey}.manifest.json`;
      await uploadObjectBuffer(
        manifestKey,
        Buffer.from(JSON.stringify(pageManifest), 'utf8'),
        'application/json'
      );

      return {
        status: 'ready',
        mode: '2D_PDF',
        pageManifest,
        manifestKey,
      };
    }

    return {
      status: 'failed',
      reason: `Unsupported 2D format ".${ext}". Supported 2D formats: DXF, PDF.`,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : 'Unexpected 2D conversion error',
    };
  }
}
