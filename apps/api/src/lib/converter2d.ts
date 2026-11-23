import zlib from 'node:zlib';
import DxfParser from 'dxf-parser';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  DxfBounds,
  DxfEntity,
  DxfLayerManifestItem,
  DxfPolylineVertex,
  DxfSceneGraph,
  Point2D,
} from '@cadline/shared';

export const DWG_UNSUPPORTED_REASON =
  'DWG is a proprietary format. Convert to DXF with ODA File Converter or LibreDWG before upload. Free online converters also work.';

export function is2DExtension(ext: string): boolean {
  const clean = ext.replace(/^\./, '').toLowerCase();
  return clean === 'dxf' || clean === 'dwg' || clean === 'pdf';
}

// ============================================================================
// AutoCAD Color Index (ACI) & Deterministic Layer Color Helpers
// ============================================================================

const ACI_PALETTE: Record<number, string> = {
  1: '#ef4444', // Red
  2: '#eab308', // Yellow
  3: '#22c55e', // Green
  4: '#06b6d4', // Cyan
  5: '#3b82f6', // Blue
  6: '#d946ef', // Magenta
  7: '#e2e8f0', // White / Light slate on dark canvas
  8: '#64748b', // Gray
  9: '#94a3b8', // Light gray
  30: '#f97316', // Orange
  40: '#f59e0b', // Amber
  140: '#38bdf8', // Sky
};

const DETERMINISTIC_LAYER_COLORS = [
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#a78bfa',
  '#2dd4bf',
  '#fb923c',
  '#60a5fa',
  '#e2e8f0',
];

export function hashLayerColor(layerName: string): string {
  let hash = 0;
  for (let i = 0; i < layerName.length; i += 1) {
    hash = (hash * 31 + layerName.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % DETERMINISTIC_LAYER_COLORS.length;
  return DETERMINISTIC_LAYER_COLORS[idx] ?? '#e2e8f0';
}

function aciOrRgbToHex(
  colorIndex?: number,
  trueColor?: number,
  fallbackLayer?: string
): string | undefined {
  if (typeof trueColor === 'number' && Number.isFinite(trueColor) && trueColor > 0) {
    return `#${(trueColor & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (typeof colorIndex === 'number' && Number.isFinite(colorIndex)) {
    const abs = Math.abs(colorIndex);
    if (ACI_PALETTE[abs]) return ACI_PALETTE[abs];
  }
  return fallbackLayer ? hashLayerColor(fallbackLayer) : undefined;
}

const INSUNITS_MAP: Record<number, string> = {
  0: 'mm',
  1: 'in',
  2: 'ft',
  4: 'mm',
  5: 'cm',
  6: 'm',
};

// Typed interfaces matching dxf-parser runtime output without `any`
interface RawDxfVertex {
  x?: number;
  y?: number;
  bulge?: number;
}

interface RawDxfEntity {
  type?: string;
  layer?: string;
  handle?: string;
  lineType?: string;
  colorIndex?: number;
  color?: number;
  vertices?: RawDxfVertex[];
  shape?: boolean;
  center?: { x?: number; y?: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  startPoint?: { x?: number; y?: number };
  endPoint?: { x?: number; y?: number };
  position?: { x?: number; y?: number };
  text?: string;
  textHeight?: number;
  height?: number;
  rotation?: number;
  name?: string;
  xScale?: number;
  yScale?: number;
  anchorPoint?: { x?: number; y?: number };
  middleOfText?: { x?: number; y?: number };
  linearOrAngularPoint1?: { x?: number; y?: number };
  linearOrAngularPoint2?: { x?: number; y?: number };
  block?: string;
}

interface RawDxfLayerRecord {
  name?: string;
  visible?: boolean;
  frozen?: boolean;
  colorIndex?: number;
  color?: number;
}

interface RawDxfBlock {
  name?: string;
  entities?: RawDxfEntity[];
}

interface RawDxfDocument {
  header?: Record<string, unknown>;
  tables?: {
    layer?: {
      layers?: Record<string, RawDxfLayerRecord>;
    };
  };
  blocks?: Record<string, RawDxfBlock>;
  entities?: RawDxfEntity[];
}

function toPoint(pt?: { x?: number; y?: number }): Point2D {
  return {
    x: typeof pt?.x === 'number' && Number.isFinite(pt.x) ? pt.x : 0,
    y: typeof pt?.y === 'number' && Number.isFinite(pt.y) ? pt.y : 0,
  };
}

function cleanMText(raw: string): string {
  return raw
    .replace(/\\P/g, '\n')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

function convertRawEntity(
  raw: RawDxfEntity,
  blocksMap?: Record<string, RawDxfBlock>
): DxfEntity | null {
  const type = (raw.type ?? '').toUpperCase();
  const layer = raw.layer && raw.layer.trim().length > 0 ? raw.layer.trim() : '0';
  const base = {
    layer,
    ...(raw.colorIndex !== undefined || raw.color !== undefined
      ? { color: aciOrRgbToHex(raw.colorIndex, raw.color) }
      : {}),
    ...(raw.handle ? { handle: raw.handle } : {}),
    ...(raw.lineType ? { lineType: raw.lineType } : {}),
  };

  if (type === 'LINE') {
    const start = raw.vertices?.[0] ? toPoint(raw.vertices[0]) : toPoint(raw.startPoint);
    const end = raw.vertices?.[1] ? toPoint(raw.vertices[1]) : toPoint(raw.endPoint);
    return { ...base, type: 'LINE', start, end };
  }

  if (type === 'CIRCLE') {
    const radius = typeof raw.radius === 'number' && raw.radius > 0 ? raw.radius : 0;
    if (radius <= 0) return null;
    return { ...base, type: 'CIRCLE', center: toPoint(raw.center), radius };
  }

  if (type === 'ARC') {
    const radius = typeof raw.radius === 'number' && raw.radius > 0 ? raw.radius : 0;
    if (radius <= 0) return null;
    // dxf-parser converts ARC startAngle/endAngle to radians; normalize to degrees
    const startRad = typeof raw.startAngle === 'number' ? raw.startAngle : 0;
    const endRad = typeof raw.endAngle === 'number' ? raw.endAngle : Math.PI * 2;
    const toDeg = (v: number) =>
      Math.abs(v) <= Math.PI * 2 + 0.01 ? (v * 180) / Math.PI : v;
    return {
      ...base,
      type: 'ARC',
      center: toPoint(raw.center),
      radius,
      startAngle: toDeg(startRad),
      endAngle: toDeg(endRad),
    };
  }

  if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
    const vertices: DxfPolylineVertex[] = (raw.vertices ?? []).map((v) => ({
      x: typeof v.x === 'number' && Number.isFinite(v.x) ? v.x : 0,
      y: typeof v.y === 'number' && Number.isFinite(v.y) ? v.y : 0,
      ...(typeof v.bulge === 'number' && v.bulge !== 0 ? { bulge: v.bulge } : {}),
    }));
    if (vertices.length < 2) return null;
    return {
      ...base,
      type: type === 'POLYLINE' ? 'POLYLINE' : 'LWPOLYLINE',
      vertices,
      closed: Boolean(raw.shape),
    };
  }

  if (type === 'TEXT' || type === 'MTEXT') {
    const pos = raw.startPoint
      ? toPoint(raw.startPoint)
      : toPoint(raw.position);
    const rawText = typeof raw.text === 'string' ? raw.text : '';
    const text = type === 'MTEXT' ? cleanMText(rawText) : rawText.trim();
    if (!text) return null;
    const height =
      typeof raw.textHeight === 'number' && raw.textHeight > 0
        ? raw.textHeight
        : typeof raw.height === 'number' && raw.height > 0
          ? raw.height
          : 3.5;
    return {
      ...base,
      type: type === 'MTEXT' ? 'MTEXT' : 'TEXT',
      position: pos,
      text,
      height,
      ...(typeof raw.rotation === 'number' ? { rotation: raw.rotation } : {}),
    };
  }

  if (type === 'INSERT') {
    const blockName = raw.name ?? '';
    if (!blockName) return null;
    return {
      ...base,
      type: 'INSERT',
      blockName,
      position: toPoint(raw.position),
      scaleX: typeof raw.xScale === 'number' && raw.xScale !== 0 ? raw.xScale : 1,
      scaleY: typeof raw.yScale === 'number' && raw.yScale !== 0 ? raw.yScale : 1,
      rotation: typeof raw.rotation === 'number' ? raw.rotation : 0,
    };
  }

  if (type === 'DIMENSION') {
    const blockName = raw.block;
    let resolvedEntities: DxfEntity[] | undefined;
    if (blockName && blocksMap?.[blockName]?.entities) {
      const converted = blocksMap[blockName].entities
        .map((child) => convertRawEntity(child))
        .filter((e): e is DxfEntity => e !== null);
      if (converted.length > 0) {
        resolvedEntities = converted;
      }
    }

    return {
      ...base,
      type: 'DIMENSION',
      ...(typeof raw.text === 'string' && raw.text.trim().length > 0
        ? { text: cleanMText(raw.text) }
        : {}),
      ...(raw.linearOrAngularPoint1 ? { start: toPoint(raw.linearOrAngularPoint1) } : {}),
      ...(raw.linearOrAngularPoint2 ? { end: toPoint(raw.linearOrAngularPoint2) } : {}),
      ...(raw.anchorPoint ? { anchorPoint: toPoint(raw.anchorPoint) } : {}),
      ...(raw.middleOfText ? { middleOfText: toPoint(raw.middleOfText) } : {}),
      ...(blockName ? { blockName } : {}),
      ...(resolvedEntities ? { resolvedEntities } : {}),
    };
  }

  return null;
}

function expandBoundsForEntity(
  entity: DxfEntity,
  blocks: Record<string, DxfEntity[]>,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  offsetX = 0,
  offsetY = 0,
  scaleX = 1,
  scaleY = 1,
  depth = 0
): void {
  const push = (x: number, y: number) => {
    const wx = offsetX + x * scaleX;
    const wy = offsetY + y * scaleY;
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    if (wx < bounds.minX) bounds.minX = wx;
    if (wy < bounds.minY) bounds.minY = wy;
    if (wx > bounds.maxX) bounds.maxX = wx;
    if (wy > bounds.maxY) bounds.maxY = wy;
  };

  switch (entity.type) {
    case 'LINE':
      push(entity.start.x, entity.start.y);
      push(entity.end.x, entity.end.y);
      break;
    case 'CIRCLE':
    case 'ARC':
      push(entity.center.x - entity.radius, entity.center.y - entity.radius);
      push(entity.center.x + entity.radius, entity.center.y + entity.radius);
      break;
    case 'LWPOLYLINE':
    case 'POLYLINE':
      for (const v of entity.vertices) push(v.x, v.y);
      break;
    case 'TEXT':
    case 'MTEXT':
      push(entity.position.x, entity.position.y);
      push(
        entity.position.x + entity.text.length * entity.height * 0.55,
        entity.position.y + entity.height
      );
      break;
    case 'INSERT': {
      push(entity.position.x, entity.position.y);
      if (depth < 5) {
        const children = blocks[entity.blockName];
        if (children) {
          for (const child of children) {
            expandBoundsForEntity(
              child,
              blocks,
              bounds,
              offsetX + entity.position.x * scaleX,
              offsetY + entity.position.y * scaleY,
              scaleX * (entity.scaleX ?? 1),
              scaleY * (entity.scaleY ?? 1),
              depth + 1
            );
          }
        }
      }
      break;
    }
    case 'DIMENSION':
      if (entity.start) push(entity.start.x, entity.start.y);
      if (entity.end) push(entity.end.x, entity.end.y);
      if (entity.anchorPoint) push(entity.anchorPoint.x, entity.anchorPoint.y);
      if (entity.middleOfText) push(entity.middleOfText.x, entity.middleOfText.y);
      if (entity.resolvedEntities && depth < 5) {
        for (const child of entity.resolvedEntities) {
          expandBoundsForEntity(child, blocks, bounds, offsetX, offsetY, scaleX, scaleY, depth + 1);
        }
      }
      break;
  }
}

export function parseDxfBufferToScene(input: Buffer | string): {
  scene: DxfSceneGraph;
  layers: DxfLayerManifestItem[];
  bounds: DxfBounds;
} {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const parser = new DxfParser();
  const parsed = parser.parseSync(text) as unknown as RawDxfDocument | null;

  if (!parsed) {
    throw new Error('Failed to parse DXF file: empty or malformed ASCII DXF content');
  }

  const rawUnits = parsed.header?.['$INSUNITS'];
  const units =
    typeof rawUnits === 'number' && INSUNITS_MAP[rawUnits]
      ? INSUNITS_MAP[rawUnits]
      : 'mm';

  // Convert blocks
  const blocks: Record<string, DxfEntity[]> = {};
  if (parsed.blocks) {
    for (const [blockName, rawBlock] of Object.entries(parsed.blocks)) {
      if (!rawBlock?.entities) continue;
      blocks[blockName] = rawBlock.entities
        .map((e) => convertRawEntity(e))
        .filter((e): e is DxfEntity => e !== null);
    }
  }

  // Convert top-level entities
  const entities: DxfEntity[] = (parsed.entities ?? [])
    .map((e) => convertRawEntity(e, parsed.blocks))
    .filter((e): e is DxfEntity => e !== null);

  // Build layer manifest preserving DXF table definitions + any entity-referenced layers
  const layerMap = new Map<string, DxfLayerManifestItem>();
  const rawLayers = parsed.tables?.layer?.layers ?? {};
  for (const [name, rec] of Object.entries(rawLayers)) {
    const cleanName = (rec.name ?? name).trim() || '0';
    const color =
      aciOrRgbToHex(rec.colorIndex, rec.color, cleanName) ?? hashLayerColor(cleanName);
    layerMap.set(cleanName, {
      name: cleanName,
      color,
      visible: rec.visible !== false && !rec.frozen,
      frozen: Boolean(rec.frozen),
      entityCount: 0,
    });
  }

  for (const ent of entities) {
    const existing = layerMap.get(ent.layer);
    if (existing) {
      existing.entityCount += 1;
    } else {
      layerMap.set(ent.layer, {
        name: ent.layer,
        color: ent.color ?? hashLayerColor(ent.layer),
        visible: true,
        entityCount: 1,
      });
    }
  }

  // Compute tight 2D bounds
  const box = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };

  for (const ent of entities) {
    expandBoundsForEntity(ent, blocks, box);
  }

  const hasValidBounds =
    Number.isFinite(box.minX) &&
    Number.isFinite(box.minY) &&
    Number.isFinite(box.maxX) &&
    Number.isFinite(box.maxY);

  const bounds: DxfBounds = hasValidBounds
    ? {
        minX: Number(box.minX.toFixed(3)),
        minY: Number(box.minY.toFixed(3)),
        maxX: Number(box.maxX.toFixed(3)),
        maxY: Number(box.maxY.toFixed(3)),
        units,
      }
    : { minX: 0, minY: 0, maxX: 297, maxY: 210, units };

  return {
    scene: {
      entities,
      blocks,
      units,
    },
    layers: Array.from(layerMap.values()),
    bounds,
  };
}

// ============================================================================
// Pure-Node PDF -> 2x PNG Rasterizer powered by pdfjs-dist operator lists
// (Zero native Cairo/C++ dependency required; crisp engineering sheet output)
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(chunk, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  chunk.writeUInt32BE(crc, 8 + data.length);
  return chunk;
}

function encodeRgbaToPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = 0; // filter None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowOff + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 6 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Compact 5x7 uppercase/ASCII bitmap glyphs for crisp titleblock/dimension labels
const FONT_5X7: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '|': ['00100', '00100', '00100', '00100', '00100', '00100', '00100'],
  '/': ['00001', '00010', '00100', '00100', '01000', '10000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

class SoftwareRasterCanvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    this.fillRect(0, 0, width, height, 250, 251, 253);
  }

  private setPixel(x: number, y: number, r: number, g: number, b: number): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return;
    const idx = (iy * this.width + ix) * 4;
    this.data[idx] = r;
    this.data[idx + 1] = g;
    this.data[idx + 2] = b;
    this.data[idx + 3] = 255;
  }

  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number
  ): void {
    const x0 = Math.max(0, Math.floor(Math.min(x, x + w)));
    const x1 = Math.min(this.width, Math.ceil(Math.max(x, x + w)));
    const y0 = Math.max(0, Math.floor(Math.min(y, y + h)));
    const y1 = Math.min(this.height, Math.ceil(Math.max(y, y + h)));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const idx = (py * this.width + px) * 4;
        this.data[idx] = r;
        this.data[idx + 1] = g;
        this.data[idx + 2] = b;
        this.data[idx + 3] = 255;
      }
    }
  }

  drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    g: number,
    b: number,
    lineWidth = 2,
    dashed = false
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist));
    const radius = Math.max(0, Math.floor((lineWidth - 1) / 2));

    for (let i = 0; i <= steps; i += 1) {
      if (dashed && Math.floor(i / 10) % 2 === 1) continue;
      const t = i / steps;
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      for (let oy = -radius; oy <= radius; oy += 1) {
        for (let ox = -radius; ox <= radius; ox += 1) {
          this.setPixel(px + ox, py + oy, r, g, b);
        }
      }
    }
  }

  drawCubicBezier(
    x0: number,
    y0: number,
    cx1: number,
    cy1: number,
    cx2: number,
    cy2: number,
    x1: number,
    y1: number,
    r: number,
    g: number,
    b: number,
    lineWidth = 2,
    dashed = false
  ): void {
    const segments = 24;
    let prevX = x0;
    let prevY = y0;
    for (let i = 1; i <= segments; i += 1) {
      const t = i / segments;
      const mt = 1 - t;
      const nx =
        mt * mt * mt * x0 +
        3 * mt * mt * t * cx1 +
        3 * mt * t * t * cx2 +
        t * t * t * x1;
      const ny =
        mt * mt * mt * y0 +
        3 * mt * mt * t * cy1 +
        3 * mt * t * t * cy2 +
        t * t * t * y1;
      this.drawLine(prevX, prevY, nx, ny, r, g, b, lineWidth, dashed);
      prevX = nx;
      prevY = ny;
    }
  }

  drawText(
    text: string,
    x: number,
    y: number,
    fontSizePx: number,
    r: number,
    g: number,
    b: number
  ): void {
    const scale = Math.max(1, Math.round(fontSizePx / 8));
    let cursorX = Math.round(x);
    const baseY = Math.round(y - 7 * scale);
    const upper = text.toUpperCase();

    for (let c = 0; c < upper.length; c += 1) {
      const glyph = FONT_5X7[upper[c]] ?? FONT_5X7[' '];
      for (let row = 0; row < glyph.length; row += 1) {
        const bits = glyph[row];
        for (let col = 0; col < bits.length; col += 1) {
          if (bits[col] === '1') {
            this.fillRect(
              cursorX + col * scale,
              baseY + row * scale,
              scale,
              scale,
              r,
              g,
              b
            );
          }
        }
      }
      cursorX += 6 * scale;
    }
  }

  toPng(): Buffer {
    return encodeRgbaToPng(this.width, this.height, this.data);
  }
}

function normalizeRgbArg(val: unknown): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return 0;
  return val <= 1 ? Math.round(val * 255) : Math.max(0, Math.min(255, Math.round(val)));
}

export async function rasterizePdfBufferToPngPages(
  input: Buffer | Uint8Array,
  scale = 2
): Promise<{
  pageCount: number;
  pageSize: { width: number; height: number };
  pages: Array<{ pageNumber: number; png: Buffer }>;
}> {
  const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input);
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;

  let pageSize = { width: 842, height: 595 };
  const pages: Array<{ pageNumber: number; png: Buffer }> = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));

    if (pageNum === 1) {
      pageSize = {
        width: Math.round(baseViewport.width),
        height: Math.round(baseViewport.height),
      };
    }

    const canvas = new SoftwareRasterCanvas(width, height);
    const opList = await page.getOperatorList();
    const { OPS } = pdfjsLib;

    let strokeColor: [number, number, number] = [20, 28, 42];
    let fillColor: [number, number, number] = [255, 255, 255];
    let lineWidth = 2;
    let dashed = false;

    const toCanvasPt = (x: number, y: number): [number, number] => [
      x * scale,
      height - y * scale,
    ];

    let curX = 0;
    let curY = 0;
    let pathOps: Array<
      | { kind: 'move'; x: number; y: number }
      | { kind: 'line'; x: number; y: number }
      | {
          kind: 'curve';
          cx1: number;
          cy1: number;
          cx2: number;
          cy2: number;
          x: number;
          y: number;
        }
      | { kind: 'rect'; x: number; y: number; w: number; h: number }
    > = [];

    const flushStroke = () => {
      let sx = 0;
      let sy = 0;
      for (const p of pathOps) {
        if (p.kind === 'move') {
          sx = p.x;
          sy = p.y;
        } else if (p.kind === 'line') {
          canvas.drawLine(
            sx,
            sy,
            p.x,
            p.y,
            strokeColor[0],
            strokeColor[1],
            strokeColor[2],
            lineWidth,
            dashed
          );
          sx = p.x;
          sy = p.y;
        } else if (p.kind === 'curve') {
          canvas.drawCubicBezier(
            sx,
            sy,
            p.cx1,
            p.cy1,
            p.cx2,
            p.cy2,
            p.x,
            p.y,
            strokeColor[0],
            strokeColor[1],
            strokeColor[2],
            lineWidth,
            dashed
          );
          sx = p.x;
          sy = p.y;
        } else if (p.kind === 'rect') {
          const x0 = p.x;
          const y0 = p.y;
          const x1 = p.x + p.w;
          const y1 = p.y + p.h;
          canvas.drawLine(x0, y0, x1, y0, strokeColor[0], strokeColor[1], strokeColor[2], lineWidth, dashed);
          canvas.drawLine(x1, y0, x1, y1, strokeColor[0], strokeColor[1], strokeColor[2], lineWidth, dashed);
          canvas.drawLine(x1, y1, x0, y1, strokeColor[0], strokeColor[1], strokeColor[2], lineWidth, dashed);
          canvas.drawLine(x0, y1, x0, y0, strokeColor[0], strokeColor[1], strokeColor[2], lineWidth, dashed);
        }
      }
      pathOps = [];
    };

    const flushFill = () => {
      for (const p of pathOps) {
        if (p.kind === 'rect') {
          canvas.fillRect(p.x, p.y, p.w, p.h, fillColor[0], fillColor[1], fillColor[2]);
        }
      }
      pathOps = [];
    };

    for (let i = 0; i < opList.fnArray.length; i += 1) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] as unknown[];

      if (fn === OPS.setStrokeRGBColor && Array.isArray(args)) {
        if (args.length === 3) {
          strokeColor = [
            normalizeRgbArg(args[0]),
            normalizeRgbArg(args[1]),
            normalizeRgbArg(args[2]),
          ];
        } else if (typeof args[0] === 'string' && args[0].startsWith('#')) {
          const hex = args[0].slice(1);
          strokeColor = [
            parseInt(hex.slice(0, 2), 16) || 0,
            parseInt(hex.slice(2, 4), 16) || 0,
            parseInt(hex.slice(4, 6), 16) || 0,
          ];
        }
      } else if (fn === OPS.setFillRGBColor && Array.isArray(args)) {
        if (args.length === 3) {
          fillColor = [
            normalizeRgbArg(args[0]),
            normalizeRgbArg(args[1]),
            normalizeRgbArg(args[2]),
          ];
        } else if (typeof args[0] === 'string' && args[0].startsWith('#')) {
          const hex = args[0].slice(1);
          fillColor = [
            parseInt(hex.slice(0, 2), 16) || 255,
            parseInt(hex.slice(2, 4), 16) || 255,
            parseInt(hex.slice(4, 6), 16) || 255,
          ];
        }
      } else if (fn === OPS.setLineWidth && typeof args?.[0] === 'number') {
        lineWidth = Math.max(1, Math.round(args[0] * scale));
      } else if (fn === OPS.setDash && Array.isArray(args)) {
        dashed = Array.isArray(args[0]) && args[0].length > 0;
      } else if (fn === OPS.constructPath && Array.isArray(args)) {
        const subOps = args[0] as number[] | undefined;
        const coords = args[1] as number[] | undefined;
        if (Array.isArray(subOps) && Array.isArray(coords)) {
          let ci = 0;
          for (const sub of subOps) {
            if (sub === OPS.moveTo) {
              const [x, y] = toCanvasPt(coords[ci++], coords[ci++]);
              curX = x;
              curY = y;
              pathOps.push({ kind: 'move', x, y });
            } else if (sub === OPS.lineTo) {
              const [x, y] = toCanvasPt(coords[ci++], coords[ci++]);
              curX = x;
              curY = y;
              pathOps.push({ kind: 'line', x, y });
            } else if (sub === OPS.curveTo) {
              const [cx1, cy1] = toCanvasPt(coords[ci++], coords[ci++]);
              const [cx2, cy2] = toCanvasPt(coords[ci++], coords[ci++]);
              const [x, y] = toCanvasPt(coords[ci++], coords[ci++]);
              curX = x;
              curY = y;
              pathOps.push({ kind: 'curve', cx1, cy1, cx2, cy2, x, y });
            } else if (sub === OPS.rectangle) {
              const rx = coords[ci++];
              const ry = coords[ci++];
              const rw = coords[ci++];
              const rh = coords[ci++];
              const [x0, yBottom] = toCanvasPt(rx, ry);
              const [, yTop] = toCanvasPt(rx, ry + rh);
              pathOps.push({
                kind: 'rect',
                x: x0,
                y: Math.min(yTop, yBottom),
                w: rw * scale,
                h: Math.abs(yBottom - yTop),
              });
            }
          }
        }
      } else if (fn === OPS.stroke || fn === OPS.closeStroke) {
        flushStroke();
      } else if (fn === OPS.fill || fn === OPS.eoFill) {
        flushFill();
      } else if (fn === OPS.fillStroke || fn === OPS.eoFillStroke) {
        const copy = [...pathOps];
        flushFill();
        pathOps = copy;
        flushStroke();
      }
    }

    // Draw PDF text items from getTextContent()
    const textContent = await page.getTextContent();
    for (const item of textContent.items) {
      if (!('str' in item) || typeof item.str !== 'string' || !item.str.trim()) {
        continue;
      }
      const tr = item.transform as number[];
      const fontSize = Math.max(8, Math.hypot(tr[0] ?? 10, tr[1] ?? 0) * scale);
      const [tx, ty] = toCanvasPt(tr[4] ?? 0, tr[5] ?? 0);
      canvas.drawText(item.str, tx, ty, fontSize, 22, 34, 52);
    }

    void curX;
    void curY;
    pages.push({ pageNumber: pageNum, png: canvas.toPng() });
  }

  await loadingTask.destroy();

  return {
    pageCount,
    pageSize,
    pages,
  };
}
