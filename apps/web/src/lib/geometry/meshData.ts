import * as THREE from 'three';
import type { Vec3Tuple } from '@cadline/shared';

export interface TriangleMeshData {
  partId: string;
  partName: string;
  /** Welded unique vertex coordinates in world space: [x0, y0, z0, x1, y1, z1, ...] */
  vertices: Float32Array;
  /** Triangle vertex indices into `vertices`: length = triangleCount * 3 */
  indices: Uint32Array;
  triangleCount: number;
  /** Unit face normals per triangle: length = triangleCount * 3 */
  triNormals: Float32Array;
  /** Area per triangle */
  triAreas: Float32Array;
  /** Centroid per triangle: length = triangleCount * 3 */
  triCentroids: Float32Array;
  /** Adjacent triangle indices sharing an edge with triangle t */
  triAdjacency: number[][];
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
  diagonal: number;
}

const WELD_PRECISION = 10000; // 0.0001 mm spatial weld grid

function weldKey(x: number, y: number, z: number): string {
  return `${Math.round(x * WELD_PRECISION)},${Math.round(y * WELD_PRECISION)},${Math.round(z * WELD_PRECISION)}`;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Builds welded world-space triangle mesh topology (normals, areas, centroids,
 * and edge adjacency) from a raw flat array of triangle vertex positions
 * `[x0,y0,z0, x1,y1,z1, x2,y2,z2, ...]`.
 */
export function buildTriangleMeshDataFromRawTriangles(
  rawPositions: Float32Array | number[],
  partId: string,
  partName = partId
): TriangleMeshData {
  const triCountRaw = Math.floor(rawPositions.length / 9);
  const vertMap = new Map<string, number>();
  const uniqueVerts: number[] = [];
  const validIndices: number[] = [];

  const getOrAddVertex = (x: number, y: number, z: number): number => {
    const key = weldKey(x, y, z);
    const existing = vertMap.get(key);
    if (existing !== undefined) return existing;
    const idx = uniqueVerts.length / 3;
    uniqueVerts.push(x, y, z);
    vertMap.set(key, idx);
    return idx;
  };

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let t = 0; t < triCountRaw; t++) {
    const base = t * 9;
    const x0 = rawPositions[base];
    const y0 = rawPositions[base + 1];
    const z0 = rawPositions[base + 2];
    const x1 = rawPositions[base + 3];
    const y1 = rawPositions[base + 4];
    const z1 = rawPositions[base + 5];
    const x2 = rawPositions[base + 6];
    const y2 = rawPositions[base + 7];
    const z2 = rawPositions[base + 8];

    const i0 = getOrAddVertex(x0, y0, z0);
    const i1 = getOrAddVertex(x1, y1, z1);
    const i2 = getOrAddVertex(x2, y2, z2);
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;

    validIndices.push(i0, i1, i2);

    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (z0 < minZ) minZ = z0;
    if (x0 > maxX) maxX = x0;
    if (y0 > maxY) maxY = y0;
    if (z0 > maxZ) maxZ = z0;

    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (z1 < minZ) minZ = z1;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
    if (z1 > maxZ) maxZ = z1;

    if (x2 < minX) minX = x2;
    if (y2 < minY) minY = y2;
    if (z2 < minZ) minZ = z2;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
    if (z2 > maxZ) maxZ = z2;
  }

  const triangleCount = validIndices.length / 3;
  const vertices = new Float32Array(uniqueVerts);
  const indices = new Uint32Array(validIndices);
  const triNormals = new Float32Array(triangleCount * 3);
  const triAreas = new Float32Array(triangleCount);
  const triCentroids = new Float32Array(triangleCount * 3);
  const triAdjacency: number[][] = Array.from({ length: triangleCount }, () => []);
  const edgeToTris = new Map<string, number[]>();

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    const ax = vertices[i0 * 3];
    const ay = vertices[i0 * 3 + 1];
    const az = vertices[i0 * 3 + 2];
    const bx = vertices[i1 * 3];
    const by = vertices[i1 * 3 + 1];
    const bz = vertices[i1 * 3 + 2];
    const cx = vertices[i2 * 3];
    const cy = vertices[i2 * 3 + 1];
    const cz = vertices[i2 * 3 + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);

    if (len > 1e-12) {
      triNormals[t * 3] = nx / len;
      triNormals[t * 3 + 1] = ny / len;
      triNormals[t * 3 + 2] = nz / len;
      triAreas[t] = 0.5 * len;
    }

    triCentroids[t * 3] = (ax + bx + cx) / 3;
    triCentroids[t * 3 + 1] = (ay + by + cy) / 3;
    triCentroids[t * 3 + 2] = (az + bz + cz) / 3;

    const edges: [number, number][] = [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ];
    for (const [u, v] of edges) {
      const ek = edgeKey(u, v);
      let list = edgeToTris.get(ek);
      if (!list) {
        list = [];
        edgeToTris.set(ek, list);
      }
      for (const other of list) {
        triAdjacency[t].push(other);
        triAdjacency[other].push(t);
      }
      list.push(t);
    }
  }

  if (triangleCount === 0) {
    minX = minY = minZ = maxX = maxY = maxZ = 0;
  }

  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const diagonal = Math.hypot(dx, dy, dz);

  return {
    partId,
    partName,
    vertices,
    indices,
    triangleCount,
    triNormals,
    triAreas,
    triCentroids,
    triAdjacency,
    bboxMin: [minX, minY, minZ],
    bboxMax: [maxX, maxY, maxZ],
    diagonal,
  };
}

/**
 * Extracts world-space welded triangle data from a Three.js BufferGeometry.
 */
export function extractTriangleMeshDataFromGeometry(
  geometry: THREE.BufferGeometry,
  partId: string,
  partName = partId,
  matrixWorld?: THREE.Matrix4
): TriangleMeshData {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count === 0) {
    return buildTriangleMeshDataFromRawTriangles([], partId, partName);
  }

  const indexAttr = geometry.getIndex();
  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);
  const raw = new Float32Array(triCount * 9);
  const v = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
    const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

    const verts = [i0, i1, i2];
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(posAttr, verts[k]);
      if (matrixWorld) v.applyMatrix4(matrixWorld);
      const out = t * 9 + k * 3;
      raw[out] = v.x;
      raw[out + 1] = v.y;
      raw[out + 2] = v.z;
    }
  }

  return buildTriangleMeshDataFromRawTriangles(raw, partId, partName);
}

/**
 * Creates a world-space indexed BufferGeometry from TriangleMeshData
 * suitable for `three-mesh-bvh` construction.
 */
export function triangleMeshDataToBufferGeometry(mesh: TriangleMeshData): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(mesh.vertices.slice(), 3));
  geom.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Resolves the canonical Cadline partId for a Three.js Mesh in a loaded GLB scene.
 */
export function resolvePartIdForMesh(mesh: THREE.Mesh, fallbackIndex: number): string {
  const userDataPartId =
    typeof mesh.userData?.partId === 'string' && mesh.userData.partId.length > 0
      ? mesh.userData.partId
      : null;
  if (userDataPartId) return userDataPartId;
  if (mesh.name && mesh.name.trim().length > 0) return mesh.name.trim();
  let cur: THREE.Object3D | null = mesh.parent;
  while (cur) {
    if (typeof cur.userData?.partId === 'string' && cur.userData.partId.length > 0) {
      return cur.userData.partId;
    }
    if (cur.name && cur.name.trim().length > 0 && cur.name !== 'Scene' && cur.name !== 'AuxScene') {
      return cur.name.trim();
    }
    cur = cur.parent;
  }
  return `part_${fallbackIndex}`;
}

/**
 * Traverses a Three.js scene root and groups all Mesh geometries by `partId`
 * into world-space welded `TriangleMeshData` instances.
 */
export function extractPartMeshesFromObject3D(root: THREE.Object3D): TriangleMeshData[] {
  root.updateMatrixWorld(true);
  const partRawBuckets = new Map<string, { partName: string; chunks: Float32Array[] }>();
  let fallbackIdx = 0;
  const v = new THREE.Vector3();

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geom = obj.geometry;
    if (!(geom instanceof THREE.BufferGeometry)) return;
    const posAttr = geom.getAttribute('position');
    if (!posAttr || posAttr.count === 0) return;

    const partId = resolvePartIdForMesh(obj, fallbackIdx++);
    const partName =
      typeof obj.userData?.partName === 'string' && obj.userData.partName.length > 0
        ? obj.userData.partName
        : obj.name || partId;

    const indexAttr = geom.getIndex();
    const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);
    if (triCount === 0) return;

    const chunk = new Float32Array(triCount * 9);
    const mw = obj.matrixWorld;
    for (let t = 0; t < triCount; t++) {
      const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
      const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;
      const ids = [i0, i1, i2];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(posAttr, ids[k]).applyMatrix4(mw);
        const out = t * 9 + k * 3;
        chunk[out] = v.x;
        chunk[out + 1] = v.y;
        chunk[out + 2] = v.z;
      }
    }

    let bucket = partRawBuckets.get(partId);
    if (!bucket) {
      bucket = { partName, chunks: [] };
      partRawBuckets.set(partId, bucket);
    }
    bucket.chunks.push(chunk);
  });

  const results: TriangleMeshData[] = [];
  for (const [partId, bucket] of partRawBuckets.entries()) {
    let totalLen = 0;
    for (const c of bucket.chunks) totalLen += c.length;
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of bucket.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    results.push(buildTriangleMeshDataFromRawTriangles(merged, partId, bucket.partName));
  }
  return results;
}

/**
 * Parses an ASCII or Binary STL ArrayBuffer directly into a `TriangleMeshData`.
 * Useful for pure unit/integration tests and verification scripts without needing WebGL.
 */
export function parseStlBufferToTriangleMeshData(
  buffer: ArrayBuffer,
  partId = 'stl_part',
  partName = partId
): TriangleMeshData {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Determine binary vs ASCII reliably: binary STL has 80-byte header + uint32 count + 50 bytes/tri
  let isBinary = false;
  if (bytes.byteLength >= 84) {
    const triCount = view.getUint32(80, true);
    if (84 + triCount * 50 === bytes.byteLength) {
      isBinary = true;
    }
  }

  if (isBinary) {
    const triCount = view.getUint32(80, true);
    const raw = new Float32Array(triCount * 9);
    let offset = 84;
    for (let t = 0; t < triCount; t++) {
      // Skip 12-byte normal
      offset += 12;
      for (let v = 0; v < 9; v++) {
        raw[t * 9 + v] = view.getFloat32(offset, true);
        offset += 4;
      }
      // Skip 2-byte attribute byte count
      offset += 2;
    }
    return buildTriangleMeshDataFromRawTriangles(raw, partId, partName);
  }

  const text = new TextDecoder().decode(bytes);
  const raw: number[] = [];
  const vertexRe = /vertex\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  let match: RegExpExecArray | null = vertexRe.exec(text);
  while (match !== null) {
    raw.push(Number(match[1]), Number(match[2]), Number(match[3]));
    match = vertexRe.exec(text);
  }
  return buildTriangleMeshDataFromRawTriangles(raw, partId, partName);
}
