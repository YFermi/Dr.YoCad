import {
  isAnnotationAnchor2D,
  isAnnotationAnchor3D,
  normalizeAnnotationAnchor,
  type AiContextStats,
  type Annotation,
  type Comment,
  type DxfBounds,
  type DxfLayerManifestItem,
  type DxfSceneGraph,
  type Measurement,
  type PartNode,
  type PdfPageManifest,
} from '@cadline/shared';

export const MAX_AI_CONTEXT_BYTES = 50 * 1024; // 50 KB hard cap
const MAX_COMMENT_BODY_CHARS = 200;
const MAX_PART_TREE_DEPTH = 3;

export interface AiFileContextInput {
  file: {
    id: string;
    name: string;
    originalName: string;
    extension: string;
    sizeBytes: number;
    status: string;
    currentVersion: number;
  };
  versionId?: string;
  partTree?: PartNode[] | null;
  dxf?: {
    scene: DxfSceneGraph;
    layers: DxfLayerManifestItem[];
    bounds: DxfBounds;
  } | null;
  pdf?: PdfPageManifest | null;
  annotations: Annotation[];
  comments: Comment[];
  measurements: Measurement[];
}

interface PrunedPartNode {
  id: string;
  name: string;
  children?: PrunedPartNode[];
  truncatedChildCount?: number;
}

function prunePartTree(nodes: PartNode[], depth = 1): PrunedPartNode[] {
  return nodes.map((node) => {
    if (depth >= MAX_PART_TREE_DEPTH) {
      return {
        id: node.id,
        name: node.name,
        ...(node.children.length > 0
          ? { truncatedChildCount: node.children.length }
          : {}),
      };
    }
    return {
      id: node.id,
      name: node.name,
      ...(node.children.length > 0
        ? { children: prunePartTree(node.children, depth + 1) }
        : {}),
    };
  });
}

function truncateText(value: string, maxChars: number): string {
  const cleaned = value.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

export interface CompactAnnotationSummary {
  ref: string;
  id: string;
  type: string;
  label: string;
  author: string;
  createdAt: string;
  commentCount: number;
  resolvedCommentCount: number;
  anchorSummary: string;
  partId?: string;
}

export interface CompactCommentSummary {
  id: string;
  annotationId: string | null;
  parentId: string | null;
  author: string;
  resolved: boolean;
  body: string;
  createdAt: string;
}

export interface CompactMeasurementSummary {
  id: string;
  type: string;
  value: number;
  unit: string;
  createdAt: string;
}

export interface DxfBomHints {
  units: string;
  bounds: DxfBounds;
  layers: Array<{ name: string; entityCount: number; visible: boolean }>;
  textEntities: Array<{ text: string; layer: string; x: number; y: number }>;
}

/**
 * Extracts ONLY layer names, bounds, and TEXT/MTEXT strings from a DXF scene graph.
 * Raw vector geometry entities (LINE/ARC/POLYLINE/CIRCLE) are NEVER forwarded to AI.
 */
export function extractDxfBomHints(
  dxf: AiFileContextInput['dxf']
): DxfBomHints | null {
  if (!dxf) return null;
  const textEntities: Array<{ text: string; layer: string; x: number; y: number }> = [];

  for (const ent of dxf.scene.entities) {
    if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
      const cleaned = ent.text.trim();
      if (cleaned) {
        textEntities.push({
          text: truncateText(cleaned, 160),
          layer: ent.layer,
          x: Number(ent.position.x.toFixed(2)),
          y: Number(ent.position.y.toFixed(2)),
        });
      }
    } else if (ent.type === 'DIMENSION' && ent.text && ent.text.trim()) {
      textEntities.push({
        text: `DIM: ${truncateText(ent.text.trim(), 80)}`,
        layer: ent.layer,
        x: Number((ent.middleOfText?.x ?? ent.anchorPoint?.x ?? 0).toFixed(2)),
        y: Number((ent.middleOfText?.y ?? ent.anchorPoint?.y ?? 0).toFixed(2)),
      });
    }
    if (textEntities.length >= 120) break;
  }

  return {
    units: dxf.bounds.units || dxf.scene.units || 'mm',
    bounds: dxf.bounds,
    layers: dxf.layers.slice(0, 60).map((l) => ({
      name: l.name,
      entityCount: l.entityCount,
      visible: l.visible,
    })),
    textEntities,
  };
}

export interface BuiltAiContext {
  serialized: string;
  orderedAnnotations: CompactAnnotationSummary[];
  stats: AiContextStats;
}

/**
 * Builds a strictly capped (<= 50 KB) JSON context payload for Gemini.
 * Never includes raw GLB mesh bytes, raw DXF vector entities, or PDF PNGs.
 * Always keeps all annotations; truncates oldest comments first when over budget.
 */
export function buildAiFileContext(input: AiFileContextInput): BuiltAiContext {
  const orderedAnnotations: CompactAnnotationSummary[] = [...input.annotations]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((ann, idx) => {
      const anchor = normalizeAnnotationAnchor(ann.payload?.anchor);
      let anchorSummary = 'unknown';
      let partId: string | undefined;
      if (isAnnotationAnchor3D(anchor)) {
        const [x, y, z] = anchor.position;
        anchorSummary = `3D (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})${
          anchor.partId ? ` part=${anchor.partId}` : ''
        }`;
        partId = anchor.partId;
      } else if (isAnnotationAnchor2D(anchor)) {
        anchorSummary = `2D ${anchor.sheet.toUpperCase()}${
          anchor.page ? ` p.${anchor.page}` : ''
        } (${anchor.x.toFixed(2)}, ${anchor.y.toFixed(2)})`;
      }
      return {
        ref: `#${idx + 1}`,
        id: ann.id,
        type: ann.type,
        label: truncateText(ann.label || `Annotation #${idx + 1}`, 160),
        author: ann.author?.name ?? 'Reviewer',
        createdAt: ann.createdAt,
        commentCount: ann.commentCount ?? 0,
        resolvedCommentCount: ann.resolvedCommentCount ?? 0,
        anchorSummary,
        ...(partId ? { partId } : {}),
      };
    });

  // Sort oldest-first so we can drop from the front if over 50 KB
  let compactComments: CompactCommentSummary[] = [...input.comments]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => ({
      id: c.id,
      annotationId: c.annotationId,
      parentId: c.parentId,
      author: c.author?.name ?? 'Reviewer',
      resolved: c.resolved,
      body: truncateText(c.body, MAX_COMMENT_BODY_CHARS),
      createdAt: c.createdAt,
    }));

  const compactMeasurements: CompactMeasurementSummary[] = input.measurements.map((m) => ({
    id: m.id,
    type: m.type,
    value: Number(m.value.toFixed(3)),
    unit: m.unit,
    createdAt: m.createdAt,
  }));

  const dxfHints = extractDxfBomHints(input.dxf);

  const buildPayload = (commentsSlice: CompactCommentSummary[], includeTextEntities: boolean) => ({
    file: {
      id: input.file.id,
      name: input.file.name,
      originalName: input.file.originalName,
      extension: input.file.extension,
      sizeBytes: input.file.sizeBytes,
      status: input.file.status,
      currentVersion: input.file.currentVersion,
      versionId: input.versionId ?? null,
    },
    ...(input.partTree && input.partTree.length > 0
      ? { partTree: prunePartTree(input.partTree) }
      : {}),
    ...(dxfHints
      ? {
          drawing2d: {
            kind: 'DXF',
            units: dxfHints.units,
            bounds: dxfHints.bounds,
            layers: dxfHints.layers,
            ...(includeTextEntities ? { textNotes: dxfHints.textEntities } : {}),
          },
        }
      : {}),
    ...(input.pdf
      ? {
          drawing2d: {
            kind: 'PDF',
            pageCount: input.pdf.pageCount,
            pageSize: input.pdf.pageSize,
          },
        }
      : {}),
    annotations: orderedAnnotations,
    comments: commentsSlice,
    measurements: compactMeasurements,
  });

  let includeTextEntities = true;
  let serialized = JSON.stringify(buildPayload(compactComments, includeTextEntities));

  // Enforce 50 KB hard cap by dropping oldest comments first (never dropping annotations)
  while (
    Buffer.byteLength(serialized, 'utf8') > MAX_AI_CONTEXT_BYTES &&
    compactComments.length > 0
  ) {
    const dropCount = Math.max(1, Math.ceil(compactComments.length * 0.2));
    compactComments = compactComments.slice(dropCount);
    serialized = JSON.stringify(buildPayload(compactComments, includeTextEntities));
  }

  if (Buffer.byteLength(serialized, 'utf8') > MAX_AI_CONTEXT_BYTES && includeTextEntities) {
    includeTextEntities = false;
    serialized = JSON.stringify(buildPayload(compactComments, includeTextEntities));
  }

  return {
    serialized,
    orderedAnnotations,
    stats: {
      annotationCount: orderedAnnotations.length,
      commentCount: compactComments.length,
      measurementCount: compactMeasurements.length,
      bytesUsed: Buffer.byteLength(serialized, 'utf8'),
    },
  };
}

/**
 * Extracts referenced annotation IDs from a Gemini text reply by resolving `#N`
 * pin references (1-indexed against orderedAnnotations) as well as direct IDs.
 */
export function extractReferencedAnnotationIds(
  replyText: string,
  orderedAnnotations: Array<{ id: string }>
): string[] {
  const found = new Set<string>();

  const pinRegex = /#(\d+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pinRegex.exec(replyText)) !== null) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < orderedAnnotations.length) {
      found.add(orderedAnnotations[index].id);
    }
  }

  for (const ann of orderedAnnotations) {
    if (ann.id && replyText.includes(ann.id)) {
      found.add(ann.id);
    }
  }

  return Array.from(found);
}
