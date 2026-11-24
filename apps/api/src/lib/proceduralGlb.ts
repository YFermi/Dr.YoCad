import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  Document,
  NodeIO,
  type Accessor,
  type Material,
  type Node as GltfNode,
} from '@gltf-transform/core';
import {
  isSolidWorksNativeFile,
  SOLIDWORKS_NATIVE_UNSUPPORTED_MESSAGE,
  type PartNode,
} from '@cadline/shared';

export interface ProceduralConversionArtifact {
  glbBuffer: Uint8Array;
  partTree: PartNode[];
}

interface OcctBrepFace {
  first: number;
  last: number;
  color: [number, number, number] | null;
}

interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  brep_faces?: OcctBrepFace[];
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index?: { array: number[] };
}

interface OcctNode {
  name?: string;
  meshes?: number[];
  children?: OcctNode[];
}

interface OcctResult {
  success: boolean;
  meshes: OcctMesh[];
  root?: OcctNode;
}

const OCCT_WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const initOcct = require(workerData.occtPath);
    const occt = await initOcct();
    const bytes = new Uint8Array(workerData.bytes);
    const ext = workerData.ext;
    const result =
      ext === 'iges' || ext === 'igs'
        ? occt.ReadIgesFile(bytes, null)
        : ext === 'brep'
          ? occt.ReadBrepFile(bytes, null)
          : occt.ReadStepFile(bytes, null);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
})();
`;

async function tessellateWithOcctWorker(
  buffer: Buffer,
  ext: string,
  timeoutMs = 120_000
): Promise<OcctResult> {
  const req = createRequire(import.meta.url);
  const occtPath = req.resolve('occt-import-js');

  return new Promise<OcctResult>((resolve, reject) => {
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const worker = new Worker(OCCT_WORKER_SCRIPT, {
      eval: true,
      workerData: {
        occtPath,
        ext,
        bytes,
      },
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `OpenCASCADE tessellation timed out after ${Math.round(timeoutMs / 1000)}s for .${ext} file`
          )
        )
      );
    }, timeoutMs);

    worker.on('message', (msg: { ok: true; result: OcctResult } | { ok: false; error: string }) => {
      if (msg.ok) {
        finish(() => resolve(msg.result));
      } else {
        finish(() => reject(new Error(msg.error || `Failed to parse .${ext} file`)));
      }
    });

    worker.on('error', (err) => {
      finish(() => reject(err));
    });

    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(() =>
          reject(new Error(`OpenCASCADE worker exited unexpectedly (code ${code}) while parsing .${ext}`))
        );
      }
    });
  });
}

function normalizeRgb(color?: [number, number, number] | null): [number, number, number] {
  if (!color || color.length < 3) {
    return [0.66, 0.72, 0.8];
  }
  const maxVal = Math.max(color[0], color[1], color[2]);
  const scale = maxVal > 1.001 ? 1 / 255 : 1;
  const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n * scale : 0.7));
  return [clamp(color[0]), clamp(color[1]), clamp(color[2])];
}

/**
 * Stable color for an uncolored part in a multi-part file, from its name path
 * (e.g. "GEARBOX/SHAFT_ASSY/GEAR"): same part -> same color across instances
 * and re-conversions, different parts -> well-separated hues. Returns linear
 * RGB (glTF baseColorFactor) for a mid-saturation sRGB color.
 */
export function partColorFromPath(path: string): [number, number, number] {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Golden-angle spacing of the hash spreads similar names apart.
  const hue = ((h % 360) + ((h >>> 9) % 7) * 137.508) % 360;
  const sat = 0.5 + ((h >>> 16) % 20) / 100; // 0.50-0.69
  const light = 0.56 + ((h >>> 24) % 10) / 100; // 0.56-0.65
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const srgb = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [toLinear(srgb(0)), toLinear(srgb(8)), toLinear(srgb(4))];
}

/** Name path of every mesh index referenced by the OCCT node tree. */
function collectMeshPaths(root: OcctNode | undefined, meshes: OcctMesh[]): Map<number, string> {
  const paths = new Map<number, string>();
  const walk = (node: OcctNode, prefix: string[]) => {
    const name = node.name?.trim();
    const here = name ? [...prefix, name] : prefix;
    for (const idx of node.meshes ?? []) {
      const meshName = meshes[idx]?.name?.trim();
      paths.set(idx, [...here, ...(meshName && meshName !== name ? [meshName] : [])].join('/'));
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  if (root) walk(root, []);
  return paths;
}

/** "GEAR", "GEAR" -> "GEAR", "GEAR (2)" among siblings. */
function dedupeSiblingNames(nodes: Array<{ partNode: PartNode; gltfNode: GltfNode }>): void {
  const seen = new Map<string, number>();
  for (const n of nodes) {
    const count = (seen.get(n.partNode.name) ?? 0) + 1;
    seen.set(n.partNode.name, count);
    if (count > 1) {
      n.partNode.name = `${n.partNode.name} (${count})`;
      n.gltfNode.setName(n.partNode.name);
    }
  }
}

function computeVertexNormals(positions: Float32Array, indices?: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);

  for (let t = 0; t < triCount; t++) {
    const i0 = indices ? indices[t * 3] : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

    const ax = positions[i0 * 3];
    const ay = positions[i0 * 3 + 1];
    const az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3];
    const by = positions[i1 * 3 + 1];
    const bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3];
    const cy = positions[i2 * 3 + 1];
    const cz = positions[i2 * 3 + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    for (const idx of [i0, i1, i2]) {
      normals[idx * 3] += nx;
      normals[idx * 3 + 1] += ny;
      normals[idx * 3 + 2] += nz;
    }
  }

  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 1e-8) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    } else {
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
  }

  return normals;
}

async function convertBrepToGlb(
  buffer: Buffer,
  ext: string,
  baseName: string
): Promise<ProceduralConversionArtifact> {
  const parsed = await tessellateWithOcctWorker(buffer, ext);

  if (!parsed || !parsed.success || !Array.isArray(parsed.meshes) || parsed.meshes.length === 0) {
    throw new Error(
      `OpenCASCADE could not tessellate ${ext.toUpperCase()} geometry — verify the file contains valid solid or surface bodies.`
    );
  }

  const doc = new Document();
  const glbBuf = doc.createBuffer();
  const scene = doc.createScene(baseName);

  const materialCache = new Map<string, Material>();
  const getMaterial = (rgb: [number, number, number]): Material => {
    const key = `${rgb[0].toFixed(3)},${rgb[1].toFixed(3)},${rgb[2].toFixed(3)}`;
    let mat = materialCache.get(key);
    if (!mat) {
      mat = doc
        .createMaterial(`Mat_${materialCache.size + 1}`)
        .setBaseColorFactor([rgb[0], rgb[1], rgb[2], 1])
        .setMetallicFactor(0.38)
        .setRoughnessFactor(0.36);
      materialCache.set(key, mat);
    }
    return mat;
  };

  // Pre-build a glTF Mesh for each valid OCCT mesh entry
  const builtMeshes = new Map<number, { mesh: ReturnType<Document['createMesh']>; name: string }>();

  // Multi-part files (assemblies): parts without a color in the file get a
  // stable per-part color so they are distinguishable. Single parts and parts
  // with file colors keep their colors.
  const meshPaths = collectMeshPaths(parsed.root, parsed.meshes);
  const renderableCount = parsed.meshes.filter(
    (m) => (m.attributes?.position?.array?.length ?? 0) >= 9
  ).length;
  const autoColor = (m: OcctMesh, meshIndex: number): [number, number, number] | null =>
    renderableCount > 1 && !m.color
      ? partColorFromPath(meshPaths.get(meshIndex) ?? m.name?.trim() ?? `mesh-${meshIndex}`)
      : null;

  parsed.meshes.forEach((m, meshIndex) => {
    const rawPos = m.attributes?.position?.array;
    if (!rawPos || rawPos.length < 9) return;

    const positions = new Float32Array(rawPos);
    const vertexCount = positions.length / 3;
    const rawIdx = m.index?.array;
    const indices32 = rawIdx && rawIdx.length >= 3 ? new Uint32Array(rawIdx) : undefined;

    const rawNorm = m.attributes?.normal?.array;
    const normals =
      rawNorm && rawNorm.length === positions.length
        ? new Float32Array(rawNorm)
        : computeVertexNormals(positions, indices32);

    const posAcc: Accessor = doc
      .createAccessor(`m${meshIndex}-pos`)
      .setType('VEC3')
      .setArray(positions)
      .setBuffer(glbBuf);
    const normAcc: Accessor = doc
      .createAccessor(`m${meshIndex}-norm`)
      .setType('VEC3')
      .setArray(normals)
      .setBuffer(glbBuf);

    const meshName = m.name?.trim() || `Part ${meshIndex + 1}`;
    const gltfMesh = doc.createMesh(meshName);
    const defaultRgb = autoColor(m, meshIndex) ?? normalizeRgb(m.color);

    // Check if brep_faces defines distinct per-face colors
    const brepFaces = m.brep_faces;
    const hasDistinctFaceColors =
      Boolean(indices32) &&
      Array.isArray(brepFaces) &&
      brepFaces.length > 1 &&
      brepFaces.some((f) => f.color !== null);

    if (hasDistinctFaceColors && indices32 && brepFaces) {
      const totalTris = Math.floor(indices32.length / 3);
      const assigned = new Uint8Array(totalTris);
      const colorBuckets = new Map<string, { rgb: [number, number, number]; tris: number[] }>();

      const pushTri = (rgb: [number, number, number], triIdx: number) => {
        const key = `${rgb[0].toFixed(3)},${rgb[1].toFixed(3)},${rgb[2].toFixed(3)}`;
        let bucket = colorBuckets.get(key);
        if (!bucket) {
          bucket = { rgb, tris: [] };
          colorBuckets.set(key, bucket);
        }
        const base = triIdx * 3;
        bucket.tris.push(indices32[base], indices32[base + 1], indices32[base + 2]);
      };

      for (const face of brepFaces) {
        const rgb = face.color ? normalizeRgb(face.color) : defaultRgb;
        const start = Math.max(0, face.first);
        const end = Math.min(totalTris - 1, face.last);
        for (let t = start; t <= end; t++) {
          if (!assigned[t]) {
            assigned[t] = 1;
            pushTri(rgb, t);
          }
        }
      }

      for (let t = 0; t < totalTris; t++) {
        if (!assigned[t]) {
          pushTri(defaultRgb, t);
        }
      }

      let bucketNum = 0;
      for (const bucket of colorBuckets.values()) {
        if (bucket.tris.length === 0) continue;
        bucketNum += 1;
        const idxArray =
          vertexCount <= 65535 ? new Uint16Array(bucket.tris) : new Uint32Array(bucket.tris);
        const idxAcc = doc
          .createAccessor(`m${meshIndex}-idx-${bucketNum}`)
          .setType('SCALAR')
          .setArray(idxArray)
          .setBuffer(glbBuf);
        const prim = doc
          .createPrimitive()
          .setAttribute('POSITION', posAcc)
          .setAttribute('NORMAL', normAcc)
          .setIndices(idxAcc)
          .setMaterial(getMaterial(bucket.rgb));
        gltfMesh.addPrimitive(prim);
      }
    } else {
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', posAcc)
        .setAttribute('NORMAL', normAcc)
        .setMaterial(getMaterial(defaultRgb));

      if (indices32) {
        const idxArray =
          vertexCount <= 65535 ? new Uint16Array(indices32) : indices32;
        const idxAcc = doc
          .createAccessor(`m${meshIndex}-idx`)
          .setType('SCALAR')
          .setArray(idxArray)
          .setBuffer(glbBuf);
        prim.setIndices(idxAcc);
      }
      gltfMesh.addPrimitive(prim);
    }

    builtMeshes.set(meshIndex, { mesh: gltfMesh, name: meshName });
  });

  if (builtMeshes.size === 0) {
    throw new Error(
      `OpenCASCADE parsed ${ext.toUpperCase()} file but produced no renderable triangles.`
    );
  }

  let partCounter = 0;
  const nextPartId = (): string => {
    partCounter += 1;
    return `part-${partCounter}`;
  };

  const referencedMeshes = new Set<number>();

  const buildHierarchy = (occtNode: OcctNode): { gltfNode: GltfNode; partNode: PartNode } | null => {
    const validMeshIndices = (occtNode.meshes ?? []).filter((idx) => builtMeshes.has(idx));
    const childResults: Array<{ gltfNode: GltfNode; partNode: PartNode }> = [];

    for (const child of occtNode.children ?? []) {
      const built = buildHierarchy(child);
      if (built) childResults.push(built);
    }

    if (validMeshIndices.length === 0 && childResults.length === 0) {
      return null;
    }

    // Unwrap anonymous empty container nodes with a single child
    if (!occtNode.name?.trim() && validMeshIndices.length === 0 && childResults.length === 1) {
      return childResults[0];
    }

    const partId = nextPartId();
    const fallbackName =
      validMeshIndices.length === 1
        ? builtMeshes.get(validMeshIndices[0])?.name || `Part ${partCounter}`
        : `Assembly ${partCounter}`;
    const nodeName = occtNode.name?.trim() || fallbackName;
    const gltfNode = doc.createNode(nodeName).setExtras({ partId });
    const partChildren: PartNode[] = [];

    if (validMeshIndices.length === 1 && childResults.length === 0) {
      const idx = validMeshIndices[0];
      referencedMeshes.add(idx);
      gltfNode.setMesh(builtMeshes.get(idx)!.mesh);
    } else {
      // occt-import-js reports the parts of a nested sub-assembly as meshes of
      // that node rather than child nodes, so rebuild one leaf per mesh.
      const siblings: Array<{ partNode: PartNode; gltfNode: GltfNode }> = [];
      for (const idx of validMeshIndices) {
        referencedMeshes.add(idx);
        const entry = builtMeshes.get(idx)!;
        const leafId = nextPartId();
        const leafNode = doc.createNode(entry.name).setMesh(entry.mesh).setExtras({ partId: leafId });
        siblings.push({ gltfNode: leafNode, partNode: { id: leafId, name: entry.name, children: [] } });
      }
      siblings.push(...childResults);
      dedupeSiblingNames(siblings);
      for (const sibling of siblings) {
        gltfNode.addChild(sibling.gltfNode);
        partChildren.push(sibling.partNode);
      }
    }

    return {
      gltfNode,
      partNode: {
        id: partId,
        name: nodeName,
        children: partChildren,
      },
    };
  };

  const partTree: PartNode[] = [];

  if (parsed.root) {
    const rootIsAnonymousWrapper =
      !parsed.root.name?.trim() &&
      (!parsed.root.meshes || parsed.root.meshes.length === 0) &&
      Array.isArray(parsed.root.children) &&
      parsed.root.children.length > 0;

    if (rootIsAnonymousWrapper) {
      for (const child of parsed.root.children ?? []) {
        const built = buildHierarchy(child);
        if (built) {
          scene.addChild(built.gltfNode);
          partTree.push(built.partNode);
        }
      }
    } else {
      const built = buildHierarchy(parsed.root);
      if (built) {
        scene.addChild(built.gltfNode);
        partTree.push(built.partNode);
      }
    }
  }

  // Attach any valid meshes not referenced by parsed.root
  for (const [meshIndex, entry] of builtMeshes.entries()) {
    if (referencedMeshes.has(meshIndex)) continue;
    const partId = nextPartId();
    const gltfNode = doc.createNode(entry.name).setMesh(entry.mesh).setExtras({ partId });
    scene.addChild(gltfNode);
    partTree.push({ id: partId, name: entry.name, children: [] });
  }

  doc.getRoot().setDefaultScene(scene);

  const io = new NodeIO();
  const glbBuffer = await io.writeBinary(doc);

  return {
    glbBuffer,
    partTree: partTree.length > 0 ? partTree : [{ id: 'part-1', name: baseName, children: [] }],
  };
}

export function createBoxGeometry(
  sx: number,
  sy: number,
  sz: number,
  cx = 0,
  cy = 0,
  cz = 0
): { positions: Float32Array; normals: Float32Array; indices: Uint16Array } {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;

  const faces: Array<{ normal: [number, number, number]; verts: Array<[number, number, number]> }> = [
    { normal: [0, 0, 1], verts: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { normal: [0, 0, -1], verts: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { normal: [0, 1, 0], verts: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { normal: [0, -1, 0], verts: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
    { normal: [1, 0, 0], verts: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { normal: [-1, 0, 0], verts: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
  ];

  const pos: number[] = [];
  const norm: number[] = [];
  const idx: number[] = [];

  faces.forEach((face, fIdx) => {
    const base = fIdx * 4;
    for (const [vx, vy, vz] of face.verts) {
      pos.push(vx + cx, vy + cy, vz + cz);
      norm.push(face.normal[0], face.normal[1], face.normal[2]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(norm),
    indices: new Uint16Array(idx),
  };
}

export function createCylinderGeometry(
  radius: number,
  height: number,
  segments = 32,
  cx = 0,
  cy = 0,
  cz = 0
): { positions: Float32Array; normals: Float32Array; indices: Uint16Array } {
  const halfH = height / 2;
  const pos: number[] = [];
  const norm: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const nx = Math.cos(theta);
    const nz = Math.sin(theta);
    const x = nx * radius + cx;
    const z = nz * radius + cz;

    pos.push(x, cy - halfH, z);
    norm.push(nx, 0, nz);

    pos.push(x, cy + halfH, z);
    norm.push(nx, 0, nz);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    idx.push(a, c, b, b, c, d);
  }

  const topCenterIdx = pos.length / 3;
  pos.push(cx, cy + halfH, cz);
  norm.push(0, 1, 0);
  const topStart = pos.length / 3;
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    pos.push(Math.cos(theta) * radius + cx, cy + halfH, Math.sin(theta) * radius + cz);
    norm.push(0, 1, 0);
  }
  for (let i = 0; i < segments; i++) {
    idx.push(topCenterIdx, topStart + i + 1, topStart + i);
  }

  const botCenterIdx = pos.length / 3;
  pos.push(cx, cy - halfH, cz);
  norm.push(0, -1, 0);
  const botStart = pos.length / 3;
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    pos.push(Math.cos(theta) * radius + cx, cy - halfH, Math.sin(theta) * radius + cz);
    norm.push(0, -1, 0);
  }
  for (let i = 0; i < segments; i++) {
    idx.push(botCenterIdx, botStart + i, botStart + i + 1);
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(norm),
    indices: new Uint16Array(idx),
  };
}

export async function buildPlanetaryGearboxGlb(): Promise<ProceduralConversionArtifact> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Planetary Gearbox Assembly');

  const addMeshPart = (
    name: string,
    partId: string,
    geom: { positions: Float32Array; normals: Float32Array; indices: Uint16Array },
    color: [number, number, number],
    metallic = 0.45,
    roughness = 0.35
  ): GltfNode => {
    const posAcc = doc.createAccessor(`${partId}-pos`).setType('VEC3').setArray(geom.positions).setBuffer(buffer);
    const normAcc = doc.createAccessor(`${partId}-norm`).setType('VEC3').setArray(geom.normals).setBuffer(buffer);
    const idxAcc = doc.createAccessor(`${partId}-idx`).setType('SCALAR').setArray(geom.indices).setBuffer(buffer);
    const mat = doc
      .createMaterial(`${name}_Mat`)
      .setBaseColorFactor([color[0], color[1], color[2], 1])
      .setMetallicFactor(metallic)
      .setRoughnessFactor(roughness);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', posAcc)
      .setAttribute('NORMAL', normAcc)
      .setIndices(idxAcc)
      .setMaterial(mat);
    const mesh = doc.createMesh(name).addPrimitive(prim);
    return doc.createNode(name).setMesh(mesh).setExtras({ partId });
  };

  const root = doc.createNode('Planetary Gearbox Assembly').setExtras({ partId: 'part-1' });
  const housingSub = doc.createNode('Housing Subassembly').setExtras({ partId: 'part-2' });
  const gearTrainSub = doc.createNode('Planetary Gear Train').setExtras({ partId: 'part-6' });

  const housingBarrel = addMeshPart(
    'Housing Barrel',
    'part-3',
    createCylinderGeometry(42, 44, 40, 0, 22, 0),
    [0.52, 0.57, 0.64],
    0.55,
    0.38
  );
  const mountingFlange = addMeshPart(
    'Mounting Flange Base',
    'part-4',
    createBoxGeometry(106, 10, 106, 0, 5, 0),
    [0.36, 0.41, 0.48],
    0.5,
    0.42
  );
  const topCollar = addMeshPart(
    'Bearing Retainer Ring',
    'part-5',
    createCylinderGeometry(34, 8, 36, 0, 48, 0),
    [0.14, 0.43, 0.85],
    0.35,
    0.3
  );

  const sunShaft = addMeshPart(
    'Sun Gear Input Shaft',
    'part-7',
    createCylinderGeometry(11, 74, 28, 0, 39, 0),
    [0.82, 0.85, 0.9],
    0.75,
    0.22
  );

  const pinionAngles = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3];
  const pinionNodes = pinionAngles.map((angle, idx) => {
    const r = 24;
    return addMeshPart(
      `Planet Pinion ${idx + 1}`,
      `part-${8 + idx}`,
      createCylinderGeometry(9.5, 18, 24, Math.cos(angle) * r, 58, Math.sin(angle) * r),
      [0.85, 0.64, 0.22],
      0.65,
      0.28
    );
  });

  housingSub.addChild(housingBarrel);
  housingSub.addChild(mountingFlange);
  housingSub.addChild(topCollar);

  gearTrainSub.addChild(sunShaft);
  for (const p of pinionNodes) {
    gearTrainSub.addChild(p);
  }

  root.addChild(housingSub);
  root.addChild(gearTrainSub);
  scene.addChild(root);
  doc.getRoot().setDefaultScene(scene);

  const io = new NodeIO();
  const glbBuffer = await io.writeBinary(doc);

  const partTree: PartNode[] = [
    {
      id: 'part-1',
      name: 'Planetary Gearbox Assembly',
      children: [
        {
          id: 'part-2',
          name: 'Housing Subassembly',
          children: [
            { id: 'part-3', name: 'Housing Barrel', children: [] },
            { id: 'part-4', name: 'Mounting Flange Base', children: [] },
            { id: 'part-5', name: 'Bearing Retainer Ring', children: [] },
          ],
        },
        {
          id: 'part-6',
          name: 'Planetary Gear Train',
          children: [
            { id: 'part-7', name: 'Sun Gear Input Shaft', children: [] },
            { id: 'part-8', name: 'Planet Pinion 1', children: [] },
            { id: 'part-9', name: 'Planet Pinion 2', children: [] },
            { id: 'part-10', name: 'Planet Pinion 3', children: [] },
          ],
        },
      ],
    },
  ];

  return { glbBuffer, partTree };
}

export async function buildCalibrationCubeGlb(
  baseName = 'Calibration Cube 50mm',
  size = 50
): Promise<ProceduralConversionArtifact> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const geom = createBoxGeometry(size, size, size, 0, size / 2, 0);

  const posAcc = doc.createAccessor('pos').setType('VEC3').setArray(geom.positions).setBuffer(buffer);
  const normAcc = doc.createAccessor('norm').setType('VEC3').setArray(geom.normals).setBuffer(buffer);
  const idxAcc = doc.createAccessor('idx').setType('SCALAR').setArray(geom.indices).setBuffer(buffer);
  const mat = doc
    .createMaterial('MachinedAluminum')
    .setBaseColorFactor([0.74, 0.78, 0.84, 1])
    .setMetallicFactor(0.42)
    .setRoughnessFactor(0.32);

  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', posAcc)
    .setAttribute('NORMAL', normAcc)
    .setIndices(idxAcc)
    .setMaterial(mat);
  const mesh = doc.createMesh(baseName).addPrimitive(prim);
  const node = doc.createNode(baseName).setMesh(mesh).setExtras({ partId: 'part-1' });
  const scene = doc.createScene(baseName).addChild(node);
  doc.getRoot().setDefaultScene(scene);

  const io = new NodeIO();
  const glbBuffer = await io.writeBinary(doc);
  return {
    glbBuffer,
    partTree: [{ id: 'part-1', name: baseName, children: [] }],
  };
}

function parseStlBuffer(buffer: Buffer): { positions: Float32Array; normals: Float32Array } {
  const isBinary =
    buffer.byteLength >= 84 &&
    buffer.byteLength === 84 + buffer.readUInt32LE(80) * 50;

  if (isBinary) {
    const triCount = buffer.readUInt32LE(80);
    const positions = new Float32Array(triCount * 9);
    const normals = new Float32Array(triCount * 9);
    let offset = 84;
    for (let i = 0; i < triCount; i++) {
      const nx = buffer.readFloatLE(offset);
      const ny = buffer.readFloatLE(offset + 4);
      const nz = buffer.readFloatLE(offset + 8);
      offset += 12;
      for (let v = 0; v < 3; v++) {
        const base = i * 9 + v * 3;
        positions[base] = buffer.readFloatLE(offset);
        positions[base + 1] = buffer.readFloatLE(offset + 4);
        positions[base + 2] = buffer.readFloatLE(offset + 8);
        normals[base] = nx;
        normals[base + 1] = ny;
        normals[base + 2] = nz;
        offset += 12;
      }
      offset += 2;
    }
    return { positions, normals };
  }

  const text = buffer.toString('utf8');
  const posList: number[] = [];
  const normList: number[] = [];
  let currentNormal: [number, number, number] = [0, 0, 1];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('facet normal')) {
      const p = line.split(/\s+/);
      currentNormal = [Number(p[2]) || 0, Number(p[3]) || 0, Number(p[4]) || 1];
    } else if (line.startsWith('vertex')) {
      const p = line.split(/\s+/);
      posList.push(Number(p[1]) || 0, Number(p[2]) || 0, Number(p[3]) || 0);
      normList.push(currentNormal[0], currentNormal[1], currentNormal[2]);
    }
  }
  if (posList.length === 0) {
    throw new Error('STL file contains no valid triangle vertices');
  }
  return { positions: new Float32Array(posList), normals: new Float32Array(normList) };
}

function parseObjBuffer(buffer: Buffer): Float32Array {
  const text = buffer.toString('utf8');
  const vertices: Array<[number, number, number]> = [];
  const positions: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      vertices.push([Number(p[1]) || 0, Number(p[2]) || 0, Number(p[3]) || 0]);
    } else if (line.startsWith('f ')) {
      const tokens = line.split(/\s+/).slice(1);
      const faceIndices = tokens.map((token) => {
        const idx = Number(token.split('/')[0]);
        return idx < 0 ? vertices.length + idx : idx - 1;
      });
      for (let i = 1; i + 1 < faceIndices.length; i++) {
        for (const vi of [faceIndices[0], faceIndices[i], faceIndices[i + 1]]) {
          const v = vertices[vi];
          if (v) positions.push(v[0], v[1], v[2]);
        }
      }
    }
  }
  if (positions.length === 0) {
    throw new Error('OBJ file contains no valid face geometry');
  }
  return new Float32Array(positions);
}

export async function convertUploadedBuffer(
  buffer: Buffer,
  fileName: string
): Promise<ProceduralConversionArtifact> {
  const ext = path.extname(fileName).replace('.', '').toLowerCase();
  const baseName = path.basename(fileName, path.extname(fileName)) || 'Uploaded Model';

  if (isSolidWorksNativeFile(fileName)) {
    throw new Error(SOLIDWORKS_NATIVE_UNSUPPORTED_MESSAGE);
  }

  if (ext === 'glb' || ext === 'gltf') {
    const io = new NodeIO();
    const doc =
      ext === 'glb'
        ? await io.readBinary(new Uint8Array(buffer))
        : await io.readJSON({ json: JSON.parse(buffer.toString('utf8')), resources: {} });

    let counter = 0;
    const walk = (node: GltfNode): PartNode => {
      counter += 1;
      const id = `part-${counter}`;
      node.setExtras({ ...(node.getExtras() ?? {}), partId: id });
      return {
        id,
        name: node.getName()?.trim() || `Part ${counter}`,
        children: node.listChildren().map(walk),
      };
    };
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const roots = scene ? scene.listChildren().map(walk) : [];
    const glbBuffer = await io.writeBinary(doc);
    return {
      glbBuffer,
      partTree: roots.length > 0 ? roots : [{ id: 'part-1', name: baseName, children: [] }],
    };
  }

  if (ext === 'stl') {
    const { positions, normals } = parseStlBuffer(buffer);
    const doc = new Document();
    const glbBuf = doc.createBuffer();
    const posAcc = doc.createAccessor('pos').setType('VEC3').setArray(positions).setBuffer(glbBuf);
    const normAcc = doc.createAccessor('norm').setType('VEC3').setArray(normals).setBuffer(glbBuf);
    const mat = doc
      .createMaterial('STLMaterial')
      .setBaseColorFactor([0.74, 0.78, 0.84, 1])
      .setMetallicFactor(0.32)
      .setRoughnessFactor(0.36);
    const prim = doc.createPrimitive().setAttribute('POSITION', posAcc).setAttribute('NORMAL', normAcc).setMaterial(mat);
    const mesh = doc.createMesh(baseName).addPrimitive(prim);
    const node = doc.createNode(baseName).setMesh(mesh).setExtras({ partId: 'part-1' });
    doc.getRoot().setDefaultScene(doc.createScene(baseName).addChild(node));
    const io = new NodeIO();
    return {
      glbBuffer: await io.writeBinary(doc),
      partTree: [{ id: 'part-1', name: baseName, children: [] }],
    };
  }

  if (ext === 'obj') {
    const positions = parseObjBuffer(buffer);
    const normals = computeVertexNormals(positions);
    const doc = new Document();
    const glbBuf = doc.createBuffer();
    const posAcc = doc.createAccessor('pos').setType('VEC3').setArray(positions).setBuffer(glbBuf);
    const normAcc = doc.createAccessor('norm').setType('VEC3').setArray(normals).setBuffer(glbBuf);
    const mat = doc
      .createMaterial('OBJMaterial')
      .setBaseColorFactor([0.72, 0.77, 0.84, 1])
      .setMetallicFactor(0.28)
      .setRoughnessFactor(0.4);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', posAcc)
      .setAttribute('NORMAL', normAcc)
      .setMaterial(mat);
    const mesh = doc.createMesh(baseName).addPrimitive(prim);
    const node = doc.createNode(baseName).setMesh(mesh).setExtras({ partId: 'part-1' });
    doc.getRoot().setDefaultScene(doc.createScene(baseName).addChild(node));
    const io = new NodeIO();
    return {
      glbBuffer: await io.writeBinary(doc),
      partTree: [{ id: 'part-1', name: baseName, children: [] }],
    };
  }

  if (ext === 'step' || ext === 'stp' || ext === 'iges' || ext === 'igs' || ext === 'brep') {
    return convertBrepToGlb(buffer, ext, baseName);
  }

  throw new Error(
    `Unsupported 3D format ".${ext || 'unknown'}". Supported formats: STEP, STP, IGES, BREP, STL, OBJ, GLB, GLTF.`
  );
}
