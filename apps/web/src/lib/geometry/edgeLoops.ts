import type { Vec3Tuple } from '@cadline/shared';
import type { TriangleMeshData } from './meshData';
import type { PlanarRegion } from './planarRegions';

export interface CircleFit2DResult {
  cx: number;
  cy: number;
  radius: number;
  rmsError: number;
  maxError: number;
  angularSpanRad: number;
}

export interface CircleLoop {
  kind: 'CIRCLE';
  id: string;
  partId: string;
  regionId: string;
  center: Vec3Tuple;
  normal: Vec3Tuple;
  radius: number;
  diameter: number;
  rmsError: number;
  isHole: boolean;
  vertexCount: number;
  points3D: Vec3Tuple[];
}

export interface PolylineLoop {
  kind: 'POLYLINE';
  id: string;
  partId: string;
  regionId: string;
  closed: boolean;
  length: number;
  points3D: Vec3Tuple[];
}

export type BoundaryLoop = CircleLoop | PolylineLoop;

/**
 * Solves a 3x3 linear system A * x = b via Gaussian elimination with partial pivoting.
 */
function solve3x3(A: number[][], b: number[]): [number, number, number] | null {
  const M = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];

  for (let col = 0; col < 3; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < 3; r++) {
      const val = Math.abs(M[r][col]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = r;
      }
    }
    if (maxVal < 1e-12) return null;
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const pivot = M[col][col];
    for (let r = col + 1; r < 3; r++) {
      const factor = M[r][col] / pivot;
      for (let c = col; c < 4; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let sum = M[r][3];
    for (let c = r + 1; c < 3; c++) sum -= M[r][c] * x[c];
    x[r] = sum / M[r][r];
  }

  if (!Number.isFinite(x[0]) || !Number.isFinite(x[1]) || !Number.isFinite(x[2])) {
    return null;
  }
  return [x[0], x[1], x[2]];
}

/**
 * Fits a 2D circle to points `[(u, v), ...]` using centered Kasa algebraic least squares
 * followed by Gauss-Newton geometric refinement.
 */
export function fitCircle2D(points: Array<[number, number]>): CircleFit2DResult | null {
  const n = points.length;
  if (n < 3) return null;

  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += points[i][0];
    meanY += points[i][1];
  }
  meanX /= n;
  meanY /= n;

  let suu = 0;
  let suv = 0;
  let svv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;

  for (let i = 0; i < n; i++) {
    const u = points[i][0] - meanX;
    const v = points[i][1] - meanY;
    const uu = u * u;
    const vv = v * v;
    suu += uu;
    suv += u * v;
    svv += vv;
    suuu += uu * u;
    svvv += vv * v;
    suvv += u * vv;
    svuu += v * uu;
  }

  // Kasa normal equations in centered coordinates
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;

  const rhs1 = 0.5 * (suuu + suvv);
  const rhs2 = 0.5 * (svvv + svuu);
  let uc = (rhs1 * svv - rhs2 * suv) / det;
  let vc = (suu * rhs2 - suv * rhs1) / det;
  let r = Math.sqrt(Math.max(1e-12, uc * uc + vc * vc + (suu + svv) / n));

  // Up to 6 Gauss-Newton geometric refinement steps on radial residual (dist_i - r)
  for (let iter = 0; iter < 6; iter++) {
    const JTJ = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const JTr = [0, 0, 0];

    for (let i = 0; i < n; i++) {
      const dx = points[i][0] - meanX - uc;
      const dy = points[i][1] - meanY - vc;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-12) continue;
      const res = dist - r;
      const j0 = -dx / dist;
      const j1 = -dy / dist;
      const j2 = -1;

      JTJ[0][0] += j0 * j0;
      JTJ[0][1] += j0 * j1;
      JTJ[0][2] += j0 * j2;
      JTJ[1][1] += j1 * j1;
      JTJ[1][2] += j1 * j2;
      JTJ[2][2] += j2 * j2;

      JTr[0] += j0 * res;
      JTr[1] += j1 * res;
      JTr[2] += j2 * res;
    }
    JTJ[1][0] = JTJ[0][1];
    JTJ[2][0] = JTJ[0][2];
    JTJ[2][1] = JTJ[1][2];

    const step = solve3x3(JTJ, [-JTr[0], -JTr[1], -JTr[2]]);
    if (!step) break;
    uc += step[0];
    vc += step[1];
    r += step[2];
    if (Math.hypot(step[0], step[1], step[2]) < 1e-7) break;
  }

  if (!Number.isFinite(r) || r <= 1e-6) return null;

  const cx = meanX + uc;
  const cy = meanY + vc;

  let sumSq = 0;
  let maxErr = 0;
  const angles: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const dx = points[i][0] - cx;
    const dy = points[i][1] - cy;
    const err = Math.abs(Math.hypot(dx, dy) - r);
    sumSq += err * err;
    if (err > maxErr) maxErr = err;
    angles[i] = Math.atan2(dy, dx);
  }

  // Compute maximum angular gap to determine angular coverage
  angles.sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? angles[i + 1] : angles[0] + Math.PI * 2;
    const gap = next - angles[i];
    if (gap > maxGap) maxGap = gap;
  }
  const angularSpanRad = Math.max(0, Math.PI * 2 - maxGap);

  return {
    cx,
    cy,
    radius: r,
    rmsError: Math.sqrt(sumSq / n),
    maxError: maxErr,
    angularSpanRad,
  };
}

function signedArea2D(pts: Array<[number, number]>): number {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return 0.5 * sum;
}

/**
 * Extracts boundary edges of a planar region, chains them into closed/open loops,
 * and classifies circular boundaries (holes and circular bosses/disks) via
 * 2D least-squares circle fitting.
 */
export function extractBoundaryLoops(
  mesh: TriangleMeshData,
  region: PlanarRegion
): BoundaryLoop[] {
  const { vertices, indices } = mesh;

  // Directed half-edges: count undirected occurrences inside region
  const undirectedCounts = new Map<string, number>();
  const directedEdges: Array<[number, number]> = [];

  for (let i = 0; i < region.triangleIndices.length; i++) {
    const t = region.triangleIndices[i];
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    const triEdges: Array<[number, number]> = [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ];
    for (const [a, b] of triEdges) {
      const uKey = a < b ? `${a}:${b}` : `${b}:${a}`;
      undirectedCounts.set(uKey, (undirectedCounts.get(uKey) ?? 0) + 1);
      directedEdges.push([a, b]);
    }
  }

  // Keep only boundary directed half-edges (shared by exactly 1 triangle in the region)
  const outgoing = new Map<number, number[]>();
  const boundaryEdges: Array<[number, number]> = [];
  for (const [a, b] of directedEdges) {
    const uKey = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (undirectedCounts.get(uKey) === 1) {
      boundaryEdges.push([a, b]);
      let list = outgoing.get(a);
      if (!list) {
        list = [];
        outgoing.set(a, list);
      }
      list.push(b);
    }
  }

  // Chain boundary edges into loops
  const usedEdge = new Set<string>();
  const rawLoops: Array<{ verts: number[]; closed: boolean }> = [];

  for (const [startA, startB] of boundaryEdges) {
    const firstKey = `${startA}->${startB}`;
    if (usedEdge.has(firstKey)) continue;

    usedEdge.add(firstKey);
    const chain: number[] = [startA, startB];
    let cur = startB;
    let closed = false;

    while (true) {
      if (cur === startA) {
        chain.pop(); // remove duplicated closing vertex
        closed = true;
        break;
      }
      const nextCandidates = outgoing.get(cur);
      if (!nextCandidates || nextCandidates.length === 0) break;

      let picked: number | null = null;
      for (const cand of nextCandidates) {
        const key = `${cur}->${cand}`;
        if (!usedEdge.has(key)) {
          picked = cand;
          usedEdge.add(key);
          break;
        }
      }
      if (picked === null) break;
      chain.push(picked);
      cur = picked;
      if (chain.length > boundaryEdges.length + 2) break;
    }

    if (chain.length >= 2) {
      rawLoops.push({ verts: chain, closed });
    }
  }

  // Compute signed area for each closed loop to detect inner holes vs outer boundary
  const loopProjections = rawLoops.map((loop) => {
    const pts3D: Vec3Tuple[] = [];
    const pts2D: Array<[number, number]> = [];
    for (const vIdx of loop.verts) {
      const x = vertices[vIdx * 3];
      const y = vertices[vIdx * 3 + 1];
      const z = vertices[vIdx * 3 + 2];
      pts3D.push([x, y, z]);
      const rx = x - region.planePoint[0];
      const ry = y - region.planePoint[1];
      const rz = z - region.planePoint[2];
      const u = rx * region.uAxis[0] + ry * region.uAxis[1] + rz * region.uAxis[2];
      const v = rx * region.vAxis[0] + ry * region.vAxis[1] + rz * region.vAxis[2];
      pts2D.push([u, v]);
    }
    const area2D = loop.closed && pts2D.length >= 3 ? signedArea2D(pts2D) : 0;
    return { loop, pts3D, pts2D, area2D };
  });

  // Outer loop has the largest absolute area (usually positive signed area in CCW plane basis)
  let maxAbsArea = 0;
  let outerSign = 1;
  for (const item of loopProjections) {
    const absA = Math.abs(item.area2D);
    if (absA > maxAbsArea) {
      maxAbsArea = absA;
      outerSign = item.area2D >= 0 ? 1 : -1;
    }
  }

  const results: BoundaryLoop[] = [];
  let circleCount = 0;
  let polyCount = 0;

  for (const item of loopProjections) {
    const { loop, pts3D, pts2D, area2D } = item;

    if (loop.closed && pts2D.length >= 8) {
      const fit = fitCircle2D(pts2D);
      if (fit && fit.radius > 0.05) {
        const diameter = fit.radius * 2;
        const tol = Math.max(0.1, 0.002 * diameter);
        const fullCircleSpan = fit.angularSpanRad >= (Math.PI * 2 * 300) / 360;

        if (fit.rmsError < tol && fit.maxError < tol * 2.5 && fullCircleSpan) {
          // Lift 2D circle center back to 3D
          const center: Vec3Tuple = [
            region.planePoint[0] + fit.cx * region.uAxis[0] + fit.cy * region.vAxis[0],
            region.planePoint[1] + fit.cx * region.uAxis[1] + fit.cy * region.vAxis[1],
            region.planePoint[2] + fit.cx * region.uAxis[2] + fit.cy * region.vAxis[2],
          ];
          // Inner hole has opposite winding to outer loop OR strictly smaller area when multiple loops exist
          const isHole =
            loopProjections.length > 1 &&
            (area2D * outerSign < 0 || Math.abs(area2D) < maxAbsArea * 0.95);

          results.push({
            kind: 'CIRCLE',
            id: `circle:${region.id}:${circleCount++}`,
            partId: region.partId,
            regionId: region.id,
            center,
            normal: region.planeNormal,
            radius: fit.radius,
            diameter,
            rmsError: fit.rmsError,
            isHole,
            vertexCount: pts2D.length,
            points3D: pts3D,
          });
          continue;
        }
      }
    }

    // Fallback: classify as polyline
    let length = 0;
    const count = loop.closed ? pts3D.length : pts3D.length - 1;
    for (let i = 0; i < count; i++) {
      const a = pts3D[i];
      const b = pts3D[(i + 1) % pts3D.length];
      length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    results.push({
      kind: 'POLYLINE',
      id: `poly:${region.id}:${polyCount++}`,
      partId: region.partId,
      regionId: region.id,
      closed: loop.closed,
      length,
      points3D: pts3D,
    });
  }

  return results;
}
