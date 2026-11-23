import type { DxfEntity, Point2D } from '@cadline/shared';
import type { SnapConfig } from '@/stores/viewer2dStore';

export type SnapType = 'endpoint' | 'midpoint' | 'intersection' | 'grid' | null;

export interface SnapResult {
  x: number;
  y: number;
  snapped: SnapType;
}

interface Segment2D {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SnapGeometryIndex {
  endpoints: Point2D[];
  midpoints: Point2D[];
  intersections: Point2D[];
}

const MAX_INTERSECTIONS = 50;
const SNAP_SCREEN_RADIUS_PX = 8;

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function transformPoint(
  pt: Point2D,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
  rotDeg: number
): Point2D {
  const scaledX = pt.x * sx;
  const scaledY = pt.y * sy;
  if (Math.abs(rotDeg) < 1e-6) {
    return { x: scaledX + tx, y: scaledY + ty };
  }
  const rad = degToRad(rotDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: scaledX * cos - scaledY * sin + tx,
    y: scaledX * sin + scaledY * cos + ty,
  };
}

function segmentIntersection(a: Segment2D, b: Segment2D): Point2D | null {
  const dx1 = a.x2 - a.x1;
  const dy1 = a.y2 - a.y1;
  const dx2 = b.x2 - b.x1;
  const dy2 = b.y2 - b.y1;

  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-7) return null;

  const t = ((b.x1 - a.x1) * dy2 - (b.y1 - a.y1) * dx2) / denom;
  const u = ((b.x1 - a.x1) * dy1 - (b.y1 - a.y1) * dx1) / denom;

  if (t >= -1e-5 && t <= 1 + 1e-5 && u >= -1e-5 && u <= 1 + 1e-5) {
    return {
      x: a.x1 + t * dx1,
      y: a.y1 + t * dy1,
    };
  }
  return null;
}

/**
 * Extracts endpoint, midpoint, and capped line-line intersection candidates
 * from visible DXF layers so pointer move lookups stay O(N) and smooth at 60 fps.
 */
export function buildSnapGeometryIndex(
  entities: DxfEntity[],
  blocks: Record<string, DxfEntity[]>,
  visibleLayers: Set<string>
): SnapGeometryIndex {
  const endpoints: Point2D[] = [];
  const midpoints: Point2D[] = [];
  const lineSegments: Segment2D[] = [];

  const visit = (
    entity: DxfEntity,
    tx: number,
    ty: number,
    sx: number,
    sy: number,
    rot: number,
    depth: number,
    visitedBlocks: Set<string>
  ) => {
    if (depth === 0 && !visibleLayers.has(entity.layer)) {
      return;
    }

    const toWorld = (p: Point2D) => transformPoint(p, tx, ty, sx, sy, rot);

    switch (entity.type) {
      case 'LINE': {
        const p1 = toWorld(entity.start);
        const p2 = toWorld(entity.end);
        endpoints.push(p1, p2);
        midpoints.push({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
        lineSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const verts = entity.vertices.map(toWorld);
        for (const v of verts) endpoints.push(v);
        const segCount = entity.closed ? verts.length : verts.length - 1;
        for (let i = 0; i < segCount; i += 1) {
          const p1 = verts[i];
          const p2 = verts[(i + 1) % verts.length];
          if (!p1 || !p2) continue;
          midpoints.push({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
          lineSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
        }
        break;
      }
      case 'CIRCLE': {
        const c = toWorld(entity.center);
        const r = entity.radius * Math.abs(sx);
        endpoints.push(
          c,
          { x: c.x + r, y: c.y },
          { x: c.x - r, y: c.y },
          { x: c.x, y: c.y + r },
          { x: c.x, y: c.y - r }
        );
        break;
      }
      case 'ARC': {
        const startRad = degToRad(entity.startAngle);
        const endRad = degToRad(entity.endAngle);
        let sweep = entity.endAngle - entity.startAngle;
        if (sweep <= 0) sweep += 360;
        const midRad = degToRad(entity.startAngle + sweep / 2);

        const pStart = toWorld({
          x: entity.center.x + Math.cos(startRad) * entity.radius,
          y: entity.center.y + Math.sin(startRad) * entity.radius,
        });
        const pEnd = toWorld({
          x: entity.center.x + Math.cos(endRad) * entity.radius,
          y: entity.center.y + Math.sin(endRad) * entity.radius,
        });
        const pMid = toWorld({
          x: entity.center.x + Math.cos(midRad) * entity.radius,
          y: entity.center.y + Math.sin(midRad) * entity.radius,
        });
        endpoints.push(pStart, pEnd, toWorld(entity.center));
        midpoints.push(pMid);
        break;
      }
      case 'INSERT': {
        if (depth >= 5 || visitedBlocks.has(entity.blockName)) break;
        const blockEntities = blocks[entity.blockName];
        if (!blockEntities) break;
        const nextVisited = new Set(visitedBlocks);
        nextVisited.add(entity.blockName);
        const origin = toWorld(entity.position);
        const nextSx = sx * (entity.scaleX ?? 1);
        const nextSy = sy * (entity.scaleY ?? 1);
        const nextRot = rot + (entity.rotation ?? 0);
        for (const child of blockEntities) {
          visit(child, origin.x, origin.y, nextSx, nextSy, nextRot, depth + 1, nextVisited);
        }
        break;
      }
      case 'DIMENSION': {
        if (entity.resolvedEntities && depth < 5) {
          for (const child of entity.resolvedEntities) {
            visit(child, tx, ty, sx, sy, rot, depth + 1, visitedBlocks);
          }
        } else {
          if (entity.start) endpoints.push(toWorld(entity.start));
          if (entity.end) endpoints.push(toWorld(entity.end));
        }
        break;
      }
      default:
        break;
    }
  };

  for (const ent of entities) {
    visit(ent, 0, 0, 1, 1, 0, 0, new Set<string>());
  }

  // Cap line-line intersections at first 50 for deterministic interactive performance
  const intersections: Point2D[] = [];
  const maxLinesToCheck = Math.min(lineSegments.length, 180);
  outer: for (let i = 0; i < maxLinesToCheck; i += 1) {
    for (let j = i + 1; j < maxLinesToCheck; j += 1) {
      const hit = segmentIntersection(lineSegments[i], lineSegments[j]);
      if (hit) {
        // Ignore shared endpoints (already covered by endpoint snapping)
        const isSharedVertex =
          Math.hypot(hit.x - lineSegments[i].x1, hit.y - lineSegments[i].y1) < 1e-3 ||
          Math.hypot(hit.x - lineSegments[i].x2, hit.y - lineSegments[i].y2) < 1e-3;
        if (!isSharedVertex) {
          intersections.push(hit);
          if (intersections.length >= MAX_INTERSECTIONS) {
            break outer;
          }
        }
      }
    }
  }

  return { endpoints, midpoints, intersections };
}

/**
 * Given a raw pointer position in model coordinates, returns the nearest active
 * snap candidate within 8 px screen distance (or grid snap when enabled).
 */
export function findSnapCandidate(
  rawPos: Point2D,
  index: SnapGeometryIndex,
  scale: number,
  snap: SnapConfig,
  gridStep = 1
): SnapResult {
  const safeScale = Math.max(scale, 0.01);
  const maxModelDist = SNAP_SCREEN_RADIUS_PX / safeScale;

  const best: {
    dist: number;
    point: Point2D | null;
    kind: SnapType;
  } = {
    dist: maxModelDist,
    point: null,
    kind: null,
  };

  const checkPool = (pool: Point2D[], kind: Exclude<SnapType, null | 'grid'>) => {
    for (const pt of pool) {
      const d = Math.hypot(pt.x - rawPos.x, pt.y - rawPos.y);
      if (d <= best.dist) {
        best.dist = d;
        best.point = pt;
        best.kind = kind;
      }
    }
  };

  if (snap.endpoint) {
    checkPool(index.endpoints, 'endpoint');
  }
  if (snap.intersection) {
    checkPool(index.intersections, 'intersection');
  }
  if (snap.midpoint) {
    checkPool(index.midpoints, 'midpoint');
  }

  if (best.point && best.kind) {
    return {
      x: best.point.x,
      y: best.point.y,
      snapped: best.kind,
    };
  }

  if (snap.grid) {
    const step = gridStep > 0 ? gridStep : 1;
    const gx = Math.round(rawPos.x / step) * step;
    const gy = Math.round(rawPos.y / step) * step;
    if (Math.hypot(gx - rawPos.x, gy - rawPos.y) <= maxModelDist * 1.5) {
      return { x: gx, y: gy, snapped: 'grid' };
    }
    return { x: gx, y: gy, snapped: 'grid' };
  }

  return {
    x: rawPos.x,
    y: rawPos.y,
    snapped: null,
  };
}

// ============================================================================
// 2D Geometry Measurement Helpers (Distance, Angle, Polygon Area)
// ============================================================================

export function computeDistance2D(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function computeAngle2DDeg(a: Point2D, vertex: Point2D, c: Point2D): number {
  const v1x = a.x - vertex.x;
  const v1y = a.y - vertex.y;
  const v2x = c.x - vertex.x;
  const v2y = c.y - vertex.y;
  const len1 = Math.hypot(v1x, v1y);
  const len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-6 || len2 < 1e-6) return 0;
  const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
  const clamped = Math.max(-1, Math.min(1, dot));
  return (Math.acos(clamped) * 180) / Math.PI;
}

export function computePolygonArea2D(points: Point2D[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    sum += curr.x * next.y - next.x * curr.y;
  }
  return Math.abs(sum) / 2;
}
