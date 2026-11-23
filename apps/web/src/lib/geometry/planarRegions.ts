import type { Vec3Tuple } from '@cadline/shared';
import type { TriangleMeshData } from './meshData';

export interface PlanarRegion {
  id: string;
  partId: string;
  planeNormal: Vec3Tuple;
  planePoint: Vec3Tuple;
  uAxis: Vec3Tuple;
  vAxis: Vec3Tuple;
  area: number;
  triangleCount: number;
  triangleIndices: number[];
  extentU: number;
  extentV: number;
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
}

export interface PlanarRegionOptions {
  /** Minimum dot product between adjacent triangle normals (default 0.995, ~5.7 deg) */
  normalDotThreshold?: number;
  /** Coplanarity distance tolerance in mm (default max(0.05, 0.001 * modelDiag)) */
  coplanarityTolerance?: number;
  /** Minimum area to retain a planar region (default 1e-4 mm^2) */
  minArea?: number;
}

export function buildPlaneBasis(normal: Vec3Tuple): { uAxis: Vec3Tuple; vAxis: Vec3Tuple } {
  const [nx, ny, nz] = normal;
  // Pick a reference vector not parallel to normal
  const refX = Math.abs(nx) < 0.9 ? 1 : 0;
  const refY = Math.abs(nx) < 0.9 ? 0 : 1;
  const refZ = 0;

  // u = normalize(ref x normal)
  let ux = refY * nz - refZ * ny;
  let uy = refZ * nx - refX * nz;
  let uz = refX * ny - refY * nx;
  const uLen = Math.hypot(ux, uy, uz) || 1;
  ux /= uLen;
  uy /= uLen;
  uz /= uLen;

  // v = normal x u
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  return {
    uAxis: [ux, uy, uz],
    vAxis: [vx, vy, vz],
  };
}

/**
 * Extracts coplanar face regions from a triangulated mesh via region growing.
 * Groups adjacent triangles whose normals match within `normalDotThreshold`
 * and whose vertices lie within `coplanarityTolerance` of the fitted plane.
 */
export function extractPlanarRegions(
  mesh: TriangleMeshData,
  options: PlanarRegionOptions = {}
): PlanarRegion[] {
  const normalDotThreshold = options.normalDotThreshold ?? 0.995;
  const coplanarityTol =
    options.coplanarityTolerance ?? Math.max(0.05, 0.001 * Math.max(mesh.diagonal, 1));
  const minArea = options.minArea ?? 1e-4;

  const { triangleCount, vertices, indices, triNormals, triAreas, triCentroids, triAdjacency } =
    mesh;
  const visited = new Uint8Array(triangleCount);
  const regions: PlanarRegion[] = [];

  for (let seed = 0; seed < triangleCount; seed++) {
    if (visited[seed]) continue;
    if (triAreas[seed] <= 1e-10) {
      visited[seed] = 1;
      continue;
    }

    visited[seed] = 1;
    const regionTris: number[] = [seed];
    const queue: number[] = [seed];

    const seedNx = triNormals[seed * 3];
    const seedNy = triNormals[seed * 3 + 1];
    const seedNz = triNormals[seed * 3 + 2];

    let sumArea = triAreas[seed];
    let sumNx = seedNx * sumArea;
    let sumNy = seedNy * sumArea;
    let sumNz = seedNz * sumArea;
    let sumCx = triCentroids[seed * 3] * sumArea;
    let sumCy = triCentroids[seed * 3 + 1] * sumArea;
    let sumCz = triCentroids[seed * 3 + 2] * sumArea;

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const curLen = Math.hypot(sumNx, sumNy, sumNz) || 1;
      const curNx = sumNx / curLen;
      const curNy = sumNy / curLen;
      const curNz = sumNz / curLen;
      const curPx = sumCx / sumArea;
      const curPy = sumCy / sumArea;
      const curPz = sumCz / sumArea;

      const neighbors = triAdjacency[cur];
      for (let k = 0; k < neighbors.length; k++) {
        const nb = neighbors[k];
        if (visited[nb] || triAreas[nb] <= 1e-10) continue;

        const nbNx = triNormals[nb * 3];
        const nbNy = triNormals[nb * 3 + 1];
        const nbNz = triNormals[nb * 3 + 2];

        const dotRunning = nbNx * curNx + nbNy * curNy + nbNz * curNz;
        const dotSeed = nbNx * seedNx + nbNy * seedNy + nbNz * seedNz;
        if (dotRunning < normalDotThreshold || dotSeed < normalDotThreshold) continue;

        // Verify all 3 vertices of candidate triangle lie within coplanarity tolerance
        let coplanar = true;
        for (let vi = 0; vi < 3; vi++) {
          const vIdx = indices[nb * 3 + vi];
          const dx = vertices[vIdx * 3] - curPx;
          const dy = vertices[vIdx * 3 + 1] - curPy;
          const dz = vertices[vIdx * 3 + 2] - curPz;
          const dist = Math.abs(dx * curNx + dy * curNy + dz * curNz);
          if (dist > coplanarityTol) {
            coplanar = false;
            break;
          }
        }
        if (!coplanar) continue;

        visited[nb] = 1;
        regionTris.push(nb);
        queue.push(nb);

        const nbArea = triAreas[nb];
        sumArea += nbArea;
        sumNx += nbNx * nbArea;
        sumNy += nbNy * nbArea;
        sumNz += nbNz * nbArea;
        sumCx += triCentroids[nb * 3] * nbArea;
        sumCy += triCentroids[nb * 3 + 1] * nbArea;
        sumCz += triCentroids[nb * 3 + 2] * nbArea;
      }
    }

    if (sumArea < minArea) continue;

    const nLen = Math.hypot(sumNx, sumNy, sumNz) || 1;
    const planeNormal: Vec3Tuple = [sumNx / nLen, sumNy / nLen, sumNz / nLen];
    const planePoint: Vec3Tuple = [sumCx / sumArea, sumCy / sumArea, sumCz / sumArea];
    const { uAxis, vAxis } = buildPlaneBasis(planeNormal);

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < regionTris.length; i++) {
      const t = regionTris[i];
      for (let vi = 0; vi < 3; vi++) {
        const vIdx = indices[t * 3 + vi];
        const x = vertices[vIdx * 3];
        const y = vertices[vIdx * 3 + 1];
        const z = vertices[vIdx * 3 + 2];

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;

        const rx = x - planePoint[0];
        const ry = y - planePoint[1];
        const rz = z - planePoint[2];
        const u = rx * uAxis[0] + ry * uAxis[1] + rz * uAxis[2];
        const v = rx * vAxis[0] + ry * vAxis[1] + rz * vAxis[2];
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }

    regions.push({
      id: `plane:${mesh.partId}:${regions.length}`,
      partId: mesh.partId,
      planeNormal,
      planePoint,
      uAxis,
      vAxis,
      area: sumArea,
      triangleCount: regionTris.length,
      triangleIndices: regionTris,
      extentU: Math.max(0, maxU - minU),
      extentV: Math.max(0, maxV - minV),
      bboxMin: [minX, minY, minZ],
      bboxMax: [maxX, maxY, maxZ],
    });
  }

  // Sort deterministically by descending area and assign stable IDs
  regions.sort((a, b) => b.area - a.area);
  for (let i = 0; i < regions.length; i++) {
    regions[i].id = `plane:${mesh.partId}:${i}`;
  }

  return regions;
}
