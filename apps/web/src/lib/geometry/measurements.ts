import * as THREE from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import type {
  MeasurementReference,
  SmartMeasurement,
  SmartMeasurementUnit,
  Vec3Tuple,
} from '@cadline/shared';
import { triangleMeshDataToBufferGeometry, type TriangleMeshData } from './meshData';

export interface SmartMeasurementResolution {
  primary: SmartMeasurement | null;
  related: SmartMeasurement[];
  error?: string;
}

export interface MeasurementContext {
  partMeshes: Map<string, TriangleMeshData>;
  bvhCache?: Map<string, { geometry: THREE.BufferGeometry; bvh: MeshBVH }>;
}

const MM_PER_INCH = 25.4;

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sub(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3Tuple, s: number): Vec3Tuple {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length3(a: Vec3Tuple): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a: Vec3Tuple): Vec3Tuple {
  const len = length3(a);
  if (len < 1e-12) return [0, 0, 1];
  return [a[0] / len, a[1] / len, a[2] / len];
}

function midpoint(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function getOrBuildBvh(
  mesh: TriangleMeshData,
  cache?: Map<string, { geometry: THREE.BufferGeometry; bvh: MeshBVH }>
): { geometry: THREE.BufferGeometry; bvh: MeshBVH } {
  const cached = cache?.get(mesh.partId);
  if (cached) return cached;
  const geometry = triangleMeshDataToBufferGeometry(mesh);
  const bvh = new MeshBVH(geometry);
  const entry = { geometry, bvh };
  cache?.set(mesh.partId, entry);
  return entry;
}

// ============================================================================
// Analytic Measurements
// ============================================================================

export function distancePointPoint(
  a: MeasurementReference,
  b: MeasurementReference
): SmartMeasurement {
  const d = length3(sub(b.position, a.position));
  return {
    id: makeId('sm_dist'),
    kind: 'distance',
    value: Number(d.toFixed(4)),
    unit: 'mm',
    references: [a, b],
    anchor: midpoint(a.position, b.position),
    lineStart: a.position,
    lineEnd: b.position,
    createdAt: nowIso(),
  };
}

export function distancePointPlane(
  pointRef: MeasurementReference,
  planeRef: MeasurementReference
): SmartMeasurement {
  const n = normalize(planeRef.normal ?? [0, 0, 1]);
  const diff = sub(pointRef.position, planeRef.position);
  const signedDist = dot(diff, n);
  const absDist = Math.abs(signedDist);
  const foot = sub(pointRef.position, scale(n, signedDist));
  return {
    id: makeId('sm_p2p'),
    kind: 'distance',
    value: Number(absDist.toFixed(4)),
    unit: 'mm',
    references: [pointRef, planeRef],
    anchor: midpoint(pointRef.position, foot),
    lineStart: pointRef.position,
    lineEnd: foot,
    label: 'Point to Plane',
    createdAt: nowIso(),
  };
}

export function distancePointLine(
  pointRef: MeasurementReference,
  lineStart: Vec3Tuple,
  lineEnd: Vec3Tuple,
  linePartId = pointRef.partId
): SmartMeasurement {
  const dir = sub(lineEnd, lineStart);
  const lenSq = dot(dir, dir);
  let foot: Vec3Tuple = lineStart;
  if (lenSq > 1e-12) {
    const t = dot(sub(pointRef.position, lineStart), dir) / lenSq;
    foot = add(lineStart, scale(dir, t));
  }
  const d = length3(sub(pointRef.position, foot));
  return {
    id: makeId('sm_p2l'),
    kind: 'distance',
    value: Number(d.toFixed(4)),
    unit: 'mm',
    references: [
      pointRef,
      {
        kind: 'edge',
        partId: linePartId,
        position: foot,
        axis: normalize(dir),
      },
    ],
    anchor: midpoint(pointRef.position, foot),
    lineStart: pointRef.position,
    lineEnd: foot,
    label: 'Point to Line',
    createdAt: nowIso(),
  };
}

export function anglePlanePlane(
  planeA: MeasurementReference,
  planeB: MeasurementReference
): SmartMeasurement {
  const nA = normalize(planeA.normal ?? [0, 0, 1]);
  const nB = normalize(planeB.normal ?? [0, 0, 1]);
  const cosAngle = clamp(dot(nA, nB), -1, 1);
  // Dihedral angle between the two oriented normals in [0, 180]
  const deg = (Math.acos(cosAngle) * 180) / Math.PI;
  const mid = midpoint(planeA.position, planeB.position);
  return {
    id: makeId('sm_ang'),
    kind: 'angle',
    value: Number(deg.toFixed(3)),
    unit: 'deg',
    references: [planeA, planeB],
    anchor: mid,
    lineStart: planeA.position,
    angleVertex: mid,
    lineEnd: planeB.position,
    label: 'Face Angle',
    createdAt: nowIso(),
  };
}

export function distancePlanePlane(
  planeA: MeasurementReference,
  planeB: MeasurementReference
): { parallel: boolean; measurement: SmartMeasurement } {
  const nA = normalize(planeA.normal ?? [0, 0, 1]);
  const nB = normalize(planeB.normal ?? [0, 0, 1]);
  const absDot = Math.abs(dot(nA, nB));

  // Parallel tolerance: |dot(nA, nB)| >= 0.999 (~2.56 degrees)
  if (absDot >= 0.999) {
    const signedDist = dot(sub(planeB.position, planeA.position), nA);
    const absDist = Math.abs(signedDist);
    // Project planeA's anchor along nA onto planeB for a clean perpendicular dimension line
    const projectedEnd = add(planeA.position, scale(nA, signedDist));
    return {
      parallel: true,
      measurement: {
        id: makeId('sm_pl2pl'),
        kind: 'distance',
        value: Number(absDist.toFixed(4)),
        unit: 'mm',
        references: [planeA, planeB],
        anchor: midpoint(planeA.position, projectedEnd),
        lineStart: planeA.position,
        lineEnd: projectedEnd,
        label: 'Face to Face',
        createdAt: nowIso(),
      },
    };
  }

  // Non-parallel faces -> suggest angle measurement with explanation
  const angle = anglePlanePlane(planeA, planeB);
  angle.note = 'Faces are not parallel — showing dihedral angle';
  return { parallel: false, measurement: angle };
}

export function angleLines(
  dirA: Vec3Tuple,
  dirB: Vec3Tuple,
  vertex: Vec3Tuple,
  startPoint: Vec3Tuple,
  endPoint: Vec3Tuple,
  refs: MeasurementReference[]
): SmartMeasurement {
  const uA = normalize(dirA);
  const uB = normalize(dirB);
  const deg = (Math.acos(clamp(dot(uA, uB), -1, 1)) * 180) / Math.PI;
  return {
    id: makeId('sm_lang'),
    kind: 'angle',
    value: Number(deg.toFixed(3)),
    unit: 'deg',
    references: refs,
    anchor: vertex,
    lineStart: startPoint,
    angleVertex: vertex,
    lineEnd: endPoint,
    createdAt: nowIso(),
  };
}

export function angleThreePoints(
  a: MeasurementReference,
  vertex: MeasurementReference,
  b: MeasurementReference
): SmartMeasurement {
  const v1 = sub(a.position, vertex.position);
  const v2 = sub(b.position, vertex.position);
  return angleLines(v1, v2, vertex.position, a.position, b.position, [a, vertex, b]);
}

export function diameterCircleOrCylinder(ref: MeasurementReference): SmartMeasurement {
  const r = ref.radius ?? 0;
  const diameter = r * 2;
  const axis = normalize(ref.axis ?? ref.normal ?? [0, 0, 1]);
  // Pick a perpendicular radial direction for the cross-diameter dimension line
  const helper: Vec3Tuple = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const radial = normalize(cross(axis, helper));
  const lineStart = sub(ref.position, scale(radial, r));
  const lineEnd = add(ref.position, scale(radial, r));
  return {
    id: makeId('sm_dia'),
    kind: 'diameter',
    value: Number(diameter.toFixed(4)),
    unit: 'mm',
    references: [ref],
    anchor: ref.position,
    lineStart,
    lineEnd,
    axis,
    radius: r,
    label: ref.kind === 'cylinder' ? 'Cylinder ⌀' : 'Hole ⌀',
    createdAt: nowIso(),
  };
}

export function centerToCenter(
  refA: MeasurementReference,
  refB: MeasurementReference
): { primary: SmartMeasurement; related: SmartMeasurement[] } {
  const cA = refA.position;
  const cB = refB.position;
  let dist = length3(sub(cB, cA));
  let lineStart = cA;
  let lineEnd = cB;
  let note: string | undefined;

  // If both have parallel axes (e.g. parallel bores/holes), report perpendicular axis-to-axis distance
  // when axes are axially offset, or direct center-to-center when coplanar.
  const axisA = refA.axis ?? refA.normal;
  const axisB = refB.axis ?? refB.normal;
  if (axisA && axisB) {
    const uA = normalize(axisA);
    const uB = normalize(axisB);
    if (Math.abs(dot(uA, uB)) > 0.995) {
      const delta = sub(cB, cA);
      const axialOffset = dot(delta, uA);
      const perpVec = sub(delta, scale(uA, axialOffset));
      const perpDist = length3(perpVec);
      if (Math.abs(axialOffset) > 0.05 && perpDist > 1e-4) {
        dist = perpDist;
        lineEnd = add(cA, perpVec);
        note = `Parallel axes (Δaxial = ${Math.abs(axialOffset).toFixed(2)} mm)`;
      }
    }
  }

  const primary: SmartMeasurement = {
    id: makeId('sm_c2c'),
    kind: 'center-to-center',
    value: Number(dist.toFixed(4)),
    unit: 'mm',
    references: [refA, refB],
    anchor: midpoint(lineStart, lineEnd),
    lineStart,
    lineEnd,
    label: 'Center-to-Center',
    ...(note ? { note } : {}),
    createdAt: nowIso(),
  };

  const related: SmartMeasurement[] = [];
  if ((refA.radius ?? 0) > 0) related.push(diameterCircleOrCylinder(refA));
  if ((refB.radius ?? 0) > 0) related.push(diameterCircleOrCylinder(refB));

  return { primary, related };
}

export function computePartBbox(mesh: TriangleMeshData): SmartMeasurement {
  const dims: Vec3Tuple = [
    Number((mesh.bboxMax[0] - mesh.bboxMin[0]).toFixed(4)),
    Number((mesh.bboxMax[1] - mesh.bboxMin[1]).toFixed(4)),
    Number((mesh.bboxMax[2] - mesh.bboxMin[2]).toFixed(4)),
  ];
  const center = midpoint(mesh.bboxMin, mesh.bboxMax);
  const maxDim = Math.max(dims[0], dims[1], dims[2]);
  return {
    id: makeId('sm_bbox'),
    kind: 'bbox',
    value: maxDim,
    unit: 'mm',
    references: [
      {
        kind: 'part',
        partId: mesh.partId,
        position: center,
        label: mesh.partName,
      },
    ],
    anchor: [center[0], mesh.bboxMax[1], center[2]],
    bboxMin: mesh.bboxMin,
    bboxMax: mesh.bboxMax,
    bboxDims: dims,
    label: `${dims[0].toFixed(1)} × ${dims[1].toFixed(1)} × ${dims[2].toFixed(1)} mm`,
    createdAt: nowIso(),
  };
}

export function computePartArea(mesh: TriangleMeshData): SmartMeasurement {
  let area = 0;
  for (let i = 0; i < mesh.triangleCount; i++) {
    area += mesh.triAreas[i];
  }
  const center = midpoint(mesh.bboxMin, mesh.bboxMax);
  return {
    id: makeId('sm_area'),
    kind: 'area',
    value: Number(area.toFixed(4)),
    unit: 'mm²',
    references: [
      {
        kind: 'part',
        partId: mesh.partId,
        position: center,
        area,
        label: mesh.partName,
      },
    ],
    anchor: center,
    label: 'Surface Area',
    createdAt: nowIso(),
  };
}

export function computePartVolumeAndCentroid(mesh: TriangleMeshData): {
  volume: number;
  centroid: Vec3Tuple;
  measurement: SmartMeasurement;
} {
  const { vertices, indices, triangleCount } = mesh;
  let signedVol6 = 0;
  let cxSum = 0;
  let cySum = 0;
  let czSum = 0;

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;

    const ax = vertices[i0];
    const ay = vertices[i0 + 1];
    const az = vertices[i0 + 2];
    const bx = vertices[i1];
    const by = vertices[i1 + 1];
    const bz = vertices[i1 + 2];
    const cx = vertices[i2];
    const cy = vertices[i2 + 1];
    const cz = vertices[i2 + 2];

    const v6 =
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);

    signedVol6 += v6;
    cxSum += v6 * (ax + bx + cx);
    cySum += v6 * (ay + by + cy);
    czSum += v6 * (az + bz + cz);
  }

  const volume = Math.abs(signedVol6) / 6;
  const centroid: Vec3Tuple =
    Math.abs(signedVol6) > 1e-9
      ? [
          cxSum / (4 * signedVol6),
          cySum / (4 * signedVol6),
          czSum / (4 * signedVol6),
        ]
      : midpoint(mesh.bboxMin, mesh.bboxMax);

  const measurement: SmartMeasurement = {
    id: makeId('sm_vol'),
    kind: 'volume',
    value: Number(volume.toFixed(4)),
    unit: 'mm³',
    references: [
      {
        kind: 'part',
        partId: mesh.partId,
        position: centroid,
        label: mesh.partName,
      },
    ],
    anchor: centroid,
    label: 'Part Volume',
    createdAt: nowIso(),
  };

  return { volume, centroid, measurement };
}

/**
 * Computes minimum wall thickness / clearance between two meshes or inside a single part
 * using `three-mesh-bvh` (`MeshBVH`).
 *
 * - Two different parts: exact BVH-accelerated mesh-to-mesh minimum distance via
 *   `MeshBVH.closestPointToGeometry`.
 * - Same part: casts inward normal rays (`-normal`) from sampled triangle centroids
 *   against the part's BVH via `raycastFirst` to locate the thinnest cross-section wall.
 */
export function minWallBetween(
  meshA: TriangleMeshData,
  meshB: TriangleMeshData,
  bvhCache?: Map<string, { geometry: THREE.BufferGeometry; bvh: MeshBVH }>
): SmartMeasurement | null {
  if (meshA.triangleCount === 0 || meshB.triangleCount === 0) return null;

  if (meshA.partId !== meshB.partId) {
    const entryA = getOrBuildBvh(meshA, bvhCache);
    const entryB = getOrBuildBvh(meshB, bvhCache);
    const targetA: HitPointInfo = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
    const targetB: HitPointInfo = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
    const identity = new THREE.Matrix4();

    const hit = entryA.bvh.closestPointToGeometry(entryB.geometry, identity, targetA, targetB);
    if (!hit) return null;

    const pA: Vec3Tuple = [targetA.point.x, targetA.point.y, targetA.point.z];
    const pB: Vec3Tuple = [targetB.point.x, targetB.point.y, targetB.point.z];
    const dist = targetA.point.distanceTo(targetB.point);

    return {
      id: makeId('sm_wall'),
      kind: 'min-wall',
      value: Number(dist.toFixed(4)),
      unit: 'mm',
      references: [
        { kind: 'part', partId: meshA.partId, position: pA, label: meshA.partName },
        { kind: 'part', partId: meshB.partId, position: pB, label: meshB.partName },
      ],
      anchor: midpoint(pA, pB),
      lineStart: pA,
      lineEnd: pB,
      label: dist < 1e-3 ? 'Parts Contacting' : 'Min Clearance',
      note:
        dist < 1e-3
          ? 'Parts are touching or intersecting (0.00 mm clearance)'
          : `Minimum distance between ${meshA.partName} and ${meshB.partName}`,
      createdAt: nowIso(),
    };
  }

  // Same part: inward normal raycasting across uniformly sampled triangles
  const entry = getOrBuildBvh(meshA, bvhCache);
  const sampleTarget = Math.min(meshA.triangleCount, 400);
  const step = Math.max(1, Math.floor(meshA.triangleCount / sampleTarget));
  const eps = Math.max(1e-3, meshA.diagonal * 1e-5);

  const ray = new THREE.Ray();
  let bestDist = Infinity;
  let bestStart: Vec3Tuple | null = null;
  let bestEnd: Vec3Tuple | null = null;

  for (let t = 0; t < meshA.triangleCount; t += step) {
    if (meshA.triAreas[t] <= 1e-8) continue;
    const cx = meshA.triCentroids[t * 3];
    const cy = meshA.triCentroids[t * 3 + 1];
    const cz = meshA.triCentroids[t * 3 + 2];
    const nx = meshA.triNormals[t * 3];
    const ny = meshA.triNormals[t * 3 + 1];
    const nz = meshA.triNormals[t * 3 + 2];

    // Cast ray inward (-normal) from just inside the surface
    ray.origin.set(cx - nx * eps, cy - ny * eps, cz - nz * eps);
    ray.direction.set(-nx, -ny, -nz).normalize();

    const hit = entry.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit) continue;
    const thickness = hit.distance + eps;
    if (thickness > eps * 4 && thickness < bestDist) {
      bestDist = thickness;
      bestStart = [cx, cy, cz];
      bestEnd = [hit.point.x, hit.point.y, hit.point.z];
    }
  }

  if (!bestStart || !bestEnd || !Number.isFinite(bestDist)) return null;

  return {
    id: makeId('sm_wall'),
    kind: 'min-wall',
    value: Number(bestDist.toFixed(4)),
    unit: 'mm',
    references: [
      { kind: 'part', partId: meshA.partId, position: bestStart, label: meshA.partName },
      { kind: 'part', partId: meshA.partId, position: bestEnd, label: meshA.partName },
    ],
    anchor: midpoint(bestStart, bestEnd),
    lineStart: bestStart,
    lineEnd: bestEnd,
    label: 'Min Wall',
    note: `Minimum opposing wall thickness across ${meshA.partName}`,
    createdAt: nowIso(),
  };
}

// ============================================================================
// Smart Dimension Auto-Resolution (Session 7 B5)
// ============================================================================

export function autoResolveSmartMeasurement(
  selection: MeasurementReference[],
  context: MeasurementContext
): SmartMeasurementResolution {
  if (selection.length === 0) {
    return { primary: null, related: [] };
  }

  if (selection.length === 1) {
    const a = selection[0];
    if (a.kind === 'circle' || a.kind === 'cylinder') {
      return { primary: diameterCircleOrCylinder(a), related: [] };
    }
    if (a.kind === 'part') {
      const mesh = context.partMeshes.get(a.partId);
      if (!mesh) return { primary: null, related: [], error: 'Part mesh unavailable' };
      const bbox = computePartBbox(mesh);
      const area = computePartArea(mesh);
      const { measurement: vol } = computePartVolumeAndCentroid(mesh);
      return { primary: bbox, related: [area, vol] };
    }
    if (a.kind === 'plane' && typeof a.area === 'number') {
      return {
        primary: {
          id: makeId('sm_farea'),
          kind: 'area',
          value: Number(a.area.toFixed(4)),
          unit: 'mm²',
          references: [a],
          anchor: a.position,
          label: 'Face Area',
          createdAt: nowIso(),
        },
        related: [],
      };
    }
    return { primary: null, related: [] };
  }

  const a = selection[0];
  const b = selection[1];

  // Two circles / cylinders -> center-to-center + both diameters
  if (
    (a.kind === 'circle' || a.kind === 'cylinder') &&
    (b.kind === 'circle' || b.kind === 'cylinder')
  ) {
    const res = centerToCenter(a, b);
    return { primary: res.primary, related: res.related };
  }

  // Two planes -> parallel distance OR angle
  if (a.kind === 'plane' && b.kind === 'plane') {
    const res = distancePlanePlane(a, b);
    return { primary: res.measurement, related: [] };
  }

  // Point + plane (either order)
  if (a.kind === 'point' && b.kind === 'plane') {
    return { primary: distancePointPlane(a, b), related: [] };
  }
  if (a.kind === 'plane' && b.kind === 'point') {
    return { primary: distancePointPlane(b, a), related: [] };
  }

  // Two parts -> min clearance / wall
  if (a.kind === 'part' && b.kind === 'part') {
    const mA = context.partMeshes.get(a.partId);
    const mB = context.partMeshes.get(b.partId);
    if (mA && mB) {
      const wall = minWallBetween(mA, mB, context.bvhCache);
      if (wall) return { primary: wall, related: [] };
    }
  }

  // 3 points -> angle at middle vertex
  if (selection.length >= 3) {
    return { primary: angleThreePoints(selection[0], selection[1], selection[2]), related: [] };
  }

  // Fallback: point-to-point distance between reference anchors
  return { primary: distancePointPoint(a, b), related: [] };
}

// ============================================================================
// Unit Conversion & Display Formatting
// ============================================================================

export function convertSmartMeasurementUnit(
  measurement: SmartMeasurement,
  targetSystem: 'mm' | 'in'
): SmartMeasurement {
  if (measurement.unit === 'deg') return measurement;
  const isCurrentlyIn =
    measurement.unit === 'in' || measurement.unit === 'in²' || measurement.unit === 'in³';
  if ((targetSystem === 'in' && isCurrentlyIn) || (targetSystem === 'mm' && !isCurrentlyIn)) {
    return measurement;
  }

  let factor = 1;
  let nextUnit: SmartMeasurementUnit = measurement.unit;
  if (measurement.unit === 'mm') {
    factor = 1 / MM_PER_INCH;
    nextUnit = 'in';
  } else if (measurement.unit === 'in') {
    factor = MM_PER_INCH;
    nextUnit = 'mm';
  } else if (measurement.unit === 'mm²') {
    factor = 1 / (MM_PER_INCH * MM_PER_INCH);
    nextUnit = 'in²';
  } else if (measurement.unit === 'in²') {
    factor = MM_PER_INCH * MM_PER_INCH;
    nextUnit = 'mm²';
  } else if (measurement.unit === 'mm³') {
    factor = 1 / (MM_PER_INCH * MM_PER_INCH * MM_PER_INCH);
    nextUnit = 'in³';
  } else if (measurement.unit === 'in³') {
    factor = MM_PER_INCH * MM_PER_INCH * MM_PER_INCH;
    nextUnit = 'mm³';
  }

  const nextBboxDims: Vec3Tuple | undefined = measurement.bboxDims
    ? [
        Number((measurement.bboxDims[0] * factor).toFixed(3)),
        Number((measurement.bboxDims[1] * factor).toFixed(3)),
        Number((measurement.bboxDims[2] * factor).toFixed(3)),
      ]
    : undefined;

  return {
    ...measurement,
    value: Number((measurement.value * factor).toFixed(4)),
    unit: nextUnit,
    ...(nextBboxDims ? { bboxDims: nextBboxDims } : {}),
  };
}

export function formatSmartMeasurementDisplay(m: SmartMeasurement): string {
  const unitLabel = m.unit === 'deg' ? '°' : ` ${m.unit}`;
  if (m.kind === 'bbox' && m.bboxDims) {
    const unit = m.unit === 'in' ? 'in' : 'mm';
    return `${m.bboxDims[0].toFixed(1)} × ${m.bboxDims[1].toFixed(1)} × ${m.bboxDims[2].toFixed(1)} ${unit}`;
  }
  const decimals = m.unit === 'in' || m.unit === 'in²' || m.unit === 'in³' ? 3 : 2;
  const numStr = m.value.toFixed(decimals);
  switch (m.kind) {
    case 'diameter':
      return `⌀${numStr}${unitLabel}`;
    case 'radius':
      return `R${numStr}${unitLabel}`;
    case 'angle':
      return `${numStr}°`;
    case 'center-to-center':
      return `C–C ${numStr}${unitLabel}`;
    case 'min-wall':
      return `Min ${numStr}${unitLabel}`;
    case 'area':
      return `${numStr}${unitLabel}`;
    case 'volume':
      return `${numStr}${unitLabel}`;
    default:
      return `${numStr}${unitLabel}`;
  }
}
