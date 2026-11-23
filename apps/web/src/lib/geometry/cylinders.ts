import type { Vec3Tuple } from '@cadline/shared';
import type { TriangleMeshData } from './meshData';
import { buildPlaneBasis, type PlanarRegion } from './planarRegions';
import { fitCircle2D } from './edgeLoops';

export interface CylinderFeature {
  id: string;
  partId: string;
  axis: Vec3Tuple;
  axisPoint: Vec3Tuple;
  radius: number;
  diameter: number;
  length: number;
  rmsError: number;
  isConcave: boolean;
  triangleCount: number;
  triangleIndices: number[];
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
}

export interface CylinderExtractionOptions {
  /** Minimum adjacent-triangle normal dot product to stay in a curved component (default 0.72, ~44 deg) */
  smoothDotThreshold?: number;
  /** Minimum triangles to attempt a cylinder fit (default 12) */
  minTriangles?: number;
  /** Maximum average |n . axis| for normals to be perpendicular to the cylinder axis (default 0.08) */
  maxAxisNormalDot?: number;
}

/**
 * Computes the unit eigenvector corresponding to the smallest eigenvalue of a
 * symmetric 3x3 positive semi-definite matrix via Jacobi eigenvalue iteration.
 */
function smallestEigenvector3x3(mat: [number, number, number, number, number, number]): Vec3Tuple {
  // mat stores upper triangle: [a00, a01, a02, a11, a12, a22]
  const A: number[][] = [
    [mat[0], mat[1], mat[2]],
    [mat[1], mat[3], mat[4]],
    [mat[2], mat[4], mat[5]],
  ];
  const V: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let iter = 0; iter < 30; iter++) {
    // Find largest off-diagonal entry
    let p = 0;
    let q = 1;
    let maxOff = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > maxOff) {
      maxOff = Math.abs(A[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(A[1][2]) > maxOff) {
      maxOff = Math.abs(A[1][2]);
      p = 1;
      q = 2;
    }
    if (maxOff < 1e-12) break;

    const app = A[p][p];
    const aqq = A[q][q];
    const apq = A[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    A[p][p] = app - t * apq;
    A[q][q] = aqq + t * apq;
    A[p][q] = 0;
    A[q][p] = 0;

    for (let r = 0; r < 3; r++) {
      if (r !== p && r !== q) {
        const arp = A[r][p];
        const arq = A[r][q];
        A[r][p] = c * arp - s * arq;
        A[p][r] = A[r][p];
        A[r][q] = s * arp + c * arq;
        A[q][r] = A[r][q];
      }
      const vrp = V[r][p];
      const vrq = V[r][q];
      V[r][p] = c * vrp - s * vrq;
      V[r][q] = s * vrp + c * vrq;
    }
  }

  let minCol = 0;
  if (A[1][1] < A[minCol][minCol]) minCol = 1;
  if (A[2][2] < A[minCol][minCol]) minCol = 2;

  const vx = V[0][minCol];
  const vy = V[1][minCol];
  const vz = V[2][minCol];
  const len = Math.hypot(vx, vy, vz) || 1;
  return [vx / len, vy / len, vz / len];
}

/**
 * Determines which planar regions are true flat faces (caps/walls) that should be
 * excluded before clustering cylindrical surfaces. Thin rectangular facets of a
 * tessellated cylinder typically have only 2 triangles and high aspect ratios, so
 * we only exclude planar regions that are genuinely large flat faces (not narrow
 * 2-triangle strips adjacent to curved neighbors).
 */
function buildExcludedPlanarTriangleSet(
  mesh: TriangleMeshData,
  planarRegions: PlanarRegion[]
): Uint8Array {
  const excluded = new Uint8Array(mesh.triangleCount);
  const { triNormals, triAdjacency } = mesh;

  for (const region of planarRegions) {
    // A genuine flat cap/wall either has >= 4 triangles with non-curved surroundings
    // OR has boundary neighbors meeting at sharp angles (dot < 0.5, e.g. 90 deg cube faces).
    if (region.triangleCount <= 2) {
      // Check if this small 2-triangle quad strip has smooth curved neighbors (cylinder facet)
      const inRegion = new Set(region.triangleIndices);
      let hasCurvedNeighbor = false;
      for (const t of region.triangleIndices) {
        const nx = triNormals[t * 3];
        const ny = triNormals[t * 3 + 1];
        const nz = triNormals[t * 3 + 2];
        for (const nb of triAdjacency[t]) {
          if (inRegion.has(nb)) continue;
          const dot =
            nx * triNormals[nb * 3] +
            ny * triNormals[nb * 3 + 1] +
            nz * triNormals[nb * 3 + 2];
          if (dot > 0.72 && dot < 0.9985) {
            hasCurvedNeighbor = true;
            break;
          }
        }
        if (hasCurvedNeighbor) break;
      }
      if (hasCurvedNeighbor) continue;
    }

    // Even a larger planar region could only be a cylinder facet if it's coplanar;
    // true planar caps meet cylinder walls at ~90 deg (dot ~ 0) so marking them
    // excluded cleanly separates the cylinder barrel from its flat caps.
    for (const t of region.triangleIndices) {
      excluded[t] = 1;
    }
  }

  return excluded;
}

/**
 * Extracts cylindrical faces (holes, bores, bosses, shafts) from a triangulated mesh.
 * Clusters smoothly curved non-planar triangles, estimates the cylinder axis via the
 * nullspace of the triangle-normal covariance matrix, and fits a 2D circle in the
 * plane perpendicular to the axis.
 */
export function extractCylinders(
  mesh: TriangleMeshData,
  planarRegions: PlanarRegion[],
  options: CylinderExtractionOptions = {}
): CylinderFeature[] {
  const smoothDot = options.smoothDotThreshold ?? 0.72;
  const minTriangles = options.minTriangles ?? 12;
  const maxAxisNormalDot = options.maxAxisNormalDot ?? 0.08;
  const radialTol = Math.max(0.05, Math.min(0.2, 0.005 * Math.max(mesh.diagonal, 1)));

  const { triangleCount, vertices, indices, triNormals, triAreas, triCentroids, triAdjacency } =
    mesh;
  const excluded = buildExcludedPlanarTriangleSet(mesh, planarRegions);
  const visited = new Uint8Array(triangleCount);
  const cylinders: CylinderFeature[] = [];

  for (let seed = 0; seed < triangleCount; seed++) {
    if (visited[seed] || excluded[seed] || triAreas[seed] <= 1e-10) continue;

    // BFS across smoothly curved non-excluded triangles
    visited[seed] = 1;
    const comp: number[] = [seed];
    const queue: number[] = [seed];
    let head = 0;

    while (head < queue.length) {
      const cur = queue[head++];
      const cnx = triNormals[cur * 3];
      const cny = triNormals[cur * 3 + 1];
      const cnz = triNormals[cur * 3 + 2];

      const neighbors = triAdjacency[cur];
      for (let k = 0; k < neighbors.length; k++) {
        const nb = neighbors[k];
        if (visited[nb] || excluded[nb] || triAreas[nb] <= 1e-10) continue;

        const dot =
          cnx * triNormals[nb * 3] +
          cny * triNormals[nb * 3 + 1] +
          cnz * triNormals[nb * 3 + 2];
        if (dot < smoothDot) continue;

        visited[nb] = 1;
        comp.push(nb);
        queue.push(nb);
      }
    }

    if (comp.length < minTriangles) continue;

    // Build area-weighted normal covariance matrix M = sum(area * n * n^T)
    let m00 = 0;
    let m01 = 0;
    let m02 = 0;
    let m11 = 0;
    let m12 = 0;
    let m22 = 0;
    let totalArea = 0;

    for (let i = 0; i < comp.length; i++) {
      const t = comp[i];
      const a = triAreas[t];
      const nx = triNormals[t * 3];
      const ny = triNormals[t * 3 + 1];
      const nz = triNormals[t * 3 + 2];
      m00 += a * nx * nx;
      m01 += a * nx * ny;
      m02 += a * nx * nz;
      m11 += a * ny * ny;
      m12 += a * ny * nz;
      m22 += a * nz * nz;
      totalArea += a;
    }
    if (totalArea <= 1e-8) continue;

    let axis = smallestEigenvector3x3([m00, m01, m02, m11, m12, m22]);
    // Canonicalize axis sign for deterministic output
    if (
      axis[2] < -1e-6 ||
      (Math.abs(axis[2]) <= 1e-6 && axis[1] < -1e-6) ||
      (Math.abs(axis[2]) <= 1e-6 && Math.abs(axis[1]) <= 1e-6 && axis[0] < 0)
    ) {
      axis = [-axis[0], -axis[1], -axis[2]];
    }

    // Verify triangle normals are perpendicular to candidate cylinder axis
    // (rejects cones and spheres whose normals tilt along all 3 axes)
    let weightedAbsDot = 0;
    for (let i = 0; i < comp.length; i++) {
      const t = comp[i];
      const dot = Math.abs(
        triNormals[t * 3] * axis[0] +
          triNormals[t * 3 + 1] * axis[1] +
          triNormals[t * 3 + 2] * axis[2]
      );
      weightedAbsDot += dot * triAreas[t];
    }
    const meanAbsDot = weightedAbsDot / totalArea;
    if (meanAbsDot > maxAxisNormalDot) continue;

    // Collect unique vertices in this curved component
    const uniqueVertIds = new Set<number>();
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < comp.length; i++) {
      const t = comp[i];
      for (let vi = 0; vi < 3; vi++) {
        const vId = indices[t * 3 + vi];
        uniqueVertIds.add(vId);
      }
    }

    const { uAxis, vAxis } = buildPlaneBasis(axis);
    const pts2D: Array<[number, number]> = [];
    let minZAxis = Infinity;
    let maxZAxis = -Infinity;

    for (const vId of uniqueVertIds) {
      const x = vertices[vId * 3];
      const y = vertices[vId * 3 + 1];
      const z = vertices[vId * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;

      const u = x * uAxis[0] + y * uAxis[1] + z * uAxis[2];
      const v = x * vAxis[0] + y * vAxis[1] + z * vAxis[2];
      const h = x * axis[0] + y * axis[1] + z * axis[2];
      pts2D.push([u, v]);
      if (h < minZAxis) minZAxis = h;
      if (h > maxZAxis) maxZAxis = h;
    }

    const length = maxZAxis - minZAxis;
    if (length < 0.05) continue;

    const fit = fitCircle2D(pts2D);
    if (!fit || fit.radius < 0.05) continue;
    // Require at least 90 degrees of arc coverage and radial residual within tolerance
    if (fit.angularSpanRad < Math.PI * 0.5) continue;
    if (fit.rmsError > radialTol || fit.maxError > radialTol * 2.5) continue;

    const midH = 0.5 * (minZAxis + maxZAxis);
    const axisPoint: Vec3Tuple = [
      fit.cx * uAxis[0] + fit.cy * vAxis[0] + midH * axis[0],
      fit.cx * uAxis[1] + fit.cy * vAxis[1] + midH * axis[1],
      fit.cx * uAxis[2] + fit.cy * vAxis[2] + midH * axis[2],
    ];

    // Determine concave (hole/bore) vs convex (boss/shaft) using radial dot with normals
    let radialDotSum = 0;
    for (let i = 0; i < comp.length; i++) {
      const t = comp[i];
      const cx = triCentroids[t * 3] - axisPoint[0];
      const cy = triCentroids[t * 3 + 1] - axisPoint[1];
      const cz = triCentroids[t * 3 + 2] - axisPoint[2];
      const proj = cx * axis[0] + cy * axis[1] + cz * axis[2];
      const rx = cx - proj * axis[0];
      const ry = cy - proj * axis[1];
      const rz = cz - proj * axis[2];
      const rLen = Math.hypot(rx, ry, rz) || 1;
      const dot =
        (rx / rLen) * triNormals[t * 3] +
        (ry / rLen) * triNormals[t * 3 + 1] +
        (rz / rLen) * triNormals[t * 3 + 2];
      radialDotSum += dot * triAreas[t];
    }

    cylinders.push({
      id: `cyl:${mesh.partId}:${cylinders.length}`,
      partId: mesh.partId,
      axis,
      axisPoint,
      radius: fit.radius,
      diameter: fit.radius * 2,
      length,
      rmsError: fit.rmsError,
      isConcave: radialDotSum < 0,
      triangleCount: comp.length,
      triangleIndices: comp,
      bboxMin: [minX, minY, minZ],
      bboxMax: [maxX, maxY, maxZ],
    });
  }

  cylinders.sort((a, b) => b.radius * b.length - a.radius * a.length);
  for (let i = 0; i < cylinders.length; i++) {
    cylinders[i].id = `cyl:${mesh.partId}:${i}`;
  }

  return cylinders;
}
