import type * as THREE from 'three';
import type {
  ExtractedFeature,
  FileFeaturesCacheData,
  MeasurementReference,
  PartMetricsSummary,
  Vec3Tuple,
} from '@cadline/shared';
import {
  extractPartMeshesFromObject3D,
  type TriangleMeshData,
} from './meshData';
import { extractPlanarRegions, type PlanarRegion } from './planarRegions';
import { extractBoundaryLoops, type CircleLoop } from './edgeLoops';
import { extractCylinders, type CylinderFeature } from './cylinders';
import { computePartArea, computePartVolumeAndCentroid } from './measurements';

export interface PartFeatureCollection {
  mesh: TriangleMeshData;
  planes: PlanarRegion[];
  circles: CircleLoop[];
  cylinders: CylinderFeature[];
  summary: PartMetricsSummary;
  /** Maps triangle index -> plane region id */
  triToPlane: Map<number, PlanarRegion>;
  /** Maps triangle index -> cylinder feature */
  triToCylinder: Map<number, CylinderFeature>;
}

export interface GeometryFeatureIndex {
  parts: Map<string, PartFeatureCollection>;
  features: ExtractedFeature[];
  featureById: Map<string, ExtractedFeature>;
  planeById: Map<string, PlanarRegion>;
  circleById: Map<string, CircleLoop>;
  cylinderById: Map<string, CylinderFeature>;
  partSummaries: PartMetricsSummary[];
}

export const FEATURE_CACHE_SCHEMA_VERSION = 1;

/**
 * Extracts all L2 geometric features (planar regions, circular edge loops,
 * cylindrical bores/bosses) and L1 part metrics (bbox, surface area, volume,
 * centroid, triangle count) from one or more `TriangleMeshData` parts.
 */
export function extractFeaturesFromPartMeshes(
  partMeshes: TriangleMeshData[]
): GeometryFeatureIndex {
  const parts = new Map<string, PartFeatureCollection>();
  const features: ExtractedFeature[] = [];
  const featureById = new Map<string, ExtractedFeature>();
  const planeById = new Map<string, PlanarRegion>();
  const circleById = new Map<string, CircleLoop>();
  const cylinderById = new Map<string, CylinderFeature>();
  const partSummaries: PartMetricsSummary[] = [];

  for (const mesh of partMeshes) {
    const planes = extractPlanarRegions(mesh);
    const cylinders = extractCylinders(mesh, planes);

    // Filter out micro-planes that were claimed as facets of a detected cylinder
    const cylinderTriSet = new Set<number>();
    for (const cyl of cylinders) {
      for (const t of cyl.triangleIndices) cylinderTriSet.add(t);
    }

    const cleanPlanes = planes.filter((p) => {
      let overlap = 0;
      for (const t of p.triangleIndices) {
        if (cylinderTriSet.has(t)) overlap++;
      }
      return overlap < p.triangleCount * 0.5;
    });

    const circles: CircleLoop[] = [];
    for (const plane of cleanPlanes) {
      const loops = extractBoundaryLoops(mesh, plane);
      for (const loop of loops) {
        if (loop.kind === 'CIRCLE') {
          circles.push(loop);
        }
      }
    }

    const triToPlane = new Map<number, PlanarRegion>();
    for (const plane of cleanPlanes) {
      planeById.set(plane.id, plane);
      for (const t of plane.triangleIndices) triToPlane.set(t, plane);
    }

    const triToCylinder = new Map<number, CylinderFeature>();
    for (const cyl of cylinders) {
      cylinderById.set(cyl.id, cyl);
      for (const t of cyl.triangleIndices) triToCylinder.set(t, cyl);
    }

    const partFeatureIds: string[] = [];

    // Register cylindrical features first (highest user utility in PartTree feature list)
    for (const cyl of cylinders) {
      const feat: ExtractedFeature = {
        id: cyl.id,
        kind: 'cylinder',
        partId: mesh.partId,
        anchor: cyl.axisPoint,
        axis: cyl.axis,
        radius: Number(cyl.radius.toFixed(4)),
        diameter: Number(cyl.diameter.toFixed(4)),
        length: Number(cyl.length.toFixed(4)),
        isConcave: cyl.isConcave,
        rmsError: Number(cyl.rmsError.toFixed(5)),
        triangleCount: cyl.triangleCount,
        bboxMin: cyl.bboxMin,
        bboxMax: cyl.bboxMax,
        summaryLabel: `${cyl.isConcave ? 'Bore' : 'Cylinder'} ⌀${cyl.diameter.toFixed(2)} × ${cyl.length.toFixed(1)} mm`,
      };
      features.push(feat);
      featureById.set(feat.id, feat);
      partFeatureIds.push(feat.id);
    }

    // Register circular edge loops
    for (const circle of circles) {
      circleById.set(circle.id, circle);
      const feat: ExtractedFeature = {
        id: circle.id,
        kind: 'circle',
        partId: mesh.partId,
        anchor: circle.center,
        normal: circle.normal,
        axis: circle.normal,
        radius: Number(circle.radius.toFixed(4)),
        diameter: Number(circle.diameter.toFixed(4)),
        isHole: circle.isHole,
        rmsError: Number(circle.rmsError.toFixed(5)),
        summaryLabel: `⌀${circle.diameter.toFixed(2)} ${circle.isHole ? 'Hole' : 'Circle'}`,
      };
      features.push(feat);
      featureById.set(feat.id, feat);
      partFeatureIds.push(feat.id);
    }

    // Register planar faces
    for (const plane of cleanPlanes) {
      const feat: ExtractedFeature = {
        id: plane.id,
        kind: 'plane',
        partId: mesh.partId,
        anchor: plane.planePoint,
        normal: plane.planeNormal,
        area: Number(plane.area.toFixed(4)),
        extentU: Number(plane.extentU.toFixed(3)),
        extentV: Number(plane.extentV.toFixed(3)),
        triangleCount: plane.triangleCount,
        bboxMin: plane.bboxMin,
        bboxMax: plane.bboxMax,
        summaryLabel: `Plane ${plane.extentU.toFixed(1)} × ${plane.extentV.toFixed(1)} mm`,
      };
      features.push(feat);
      featureById.set(feat.id, feat);
      partFeatureIds.push(feat.id);
    }

    const areaMeasurement = computePartArea(mesh);
    const { volume, centroid } = computePartVolumeAndCentroid(mesh);
    const bboxDims: Vec3Tuple = [
      Number((mesh.bboxMax[0] - mesh.bboxMin[0]).toFixed(4)),
      Number((mesh.bboxMax[1] - mesh.bboxMin[1]).toFixed(4)),
      Number((mesh.bboxMax[2] - mesh.bboxMin[2]).toFixed(4)),
    ];

    const summary: PartMetricsSummary = {
      partId: mesh.partId,
      partName: mesh.partName,
      bboxMin: mesh.bboxMin,
      bboxMax: mesh.bboxMax,
      bboxDims,
      surfaceArea: Number(areaMeasurement.value.toFixed(4)),
      volume: Number(volume.toFixed(4)),
      centroid: [
        Number(centroid[0].toFixed(4)),
        Number(centroid[1].toFixed(4)),
        Number(centroid[2].toFixed(4)),
      ],
      triangleCount: mesh.triangleCount,
      featureIds: partFeatureIds,
    };
    partSummaries.push(summary);

    parts.set(mesh.partId, {
      mesh,
      planes: cleanPlanes,
      circles,
      cylinders,
      summary,
      triToPlane,
      triToCylinder,
    });
  }

  return {
    parts,
    features,
    featureById,
    planeById,
    circleById,
    cylinderById,
    partSummaries,
  };
}

export function extractFeaturesFromObject3D(root: THREE.Object3D): GeometryFeatureIndex {
  const partMeshes = extractPartMeshesFromObject3D(root);
  return extractFeaturesFromPartMeshes(partMeshes);
}

/**
 * Converts an `ExtractedFeature` into a `MeasurementReference` suitable for
 * feeding into Smart Dimension or Quick Measure.
 */
export function featureToMeasurementReference(feature: ExtractedFeature): MeasurementReference {
  return {
    kind: feature.kind,
    partId: feature.partId,
    featureId: feature.id,
    position: feature.anchor,
    ...(feature.normal ? { normal: feature.normal } : {}),
    ...(feature.axis ? { axis: feature.axis } : {}),
    ...(feature.radius !== undefined ? { radius: feature.radius } : {}),
    ...(feature.length !== undefined ? { length: feature.length } : {}),
    ...(feature.area !== undefined ? { area: feature.area } : {}),
    label: feature.summaryLabel,
  };
}

/**
 * Resolves a 3D raycast hit `(partId, hitPoint, faceNormal)` to the highest-priority
 * L2 feature under the cursor:
 *   1. Nearby circular edge loop (if hit point is within rim snap band)
 *   2. Cylinder surface (if hit point lies on a cylinder wall)
 *   3. Planar face (if hit point lies on a planar region)
 *   4. Raw surface point fallback
 */
export function resolveHitToMeasurementReference(
  index: GeometryFeatureIndex,
  partId: string,
  hitPoint: Vec3Tuple,
  hitNormal?: Vec3Tuple,
  preferCircleOrCylinder = false
): { reference: MeasurementReference; feature: ExtractedFeature | null } {
  const part = index.parts.get(partId);
  if (!part) {
    return {
      reference: {
        kind: 'point',
        partId,
        position: hitPoint,
        ...(hitNormal ? { normal: hitNormal } : {}),
      },
      feature: null,
    };
  }

  const snapBand = Math.max(0.6, Math.min(2.5, part.mesh.diagonal * 0.02));

  // 1. Check circular edge loops near hit point
  let bestCircle: CircleLoop | null = null;
  let bestCircleErr = Infinity;
  for (const circle of part.circles) {
    const dx = hitPoint[0] - circle.center[0];
    const dy = hitPoint[1] - circle.center[1];
    const dz = hitPoint[2] - circle.center[2];
    const planeDist = Math.abs(
      dx * circle.normal[0] + dy * circle.normal[1] + dz * circle.normal[2]
    );
    if (planeDist > snapBand) continue;
    const radialDist = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - planeDist * planeDist));
    const rimErr = Math.abs(radialDist - circle.radius);
    const tol = preferCircleOrCylinder ? Math.max(snapBand * 2, circle.radius * 0.45) : snapBand;
    if (rimErr <= tol && rimErr < bestCircleErr) {
      bestCircleErr = rimErr;
      bestCircle = circle;
    }
  }

  if (bestCircle) {
    const feat = index.featureById.get(bestCircle.id) ?? null;
    if (feat) {
      return { reference: featureToMeasurementReference(feat), feature: feat };
    }
  }

  // 2. Check cylinders (closest radial match within axial bounds)
  let bestCyl: CylinderFeature | null = null;
  let bestCylErr = Infinity;
  for (const cyl of part.cylinders) {
    const dx = hitPoint[0] - cyl.axisPoint[0];
    const dy = hitPoint[1] - cyl.axisPoint[1];
    const dz = hitPoint[2] - cyl.axisPoint[2];
    const axial = dx * cyl.axis[0] + dy * cyl.axis[1] + dz * cyl.axis[2];
    if (Math.abs(axial) > cyl.length * 0.55 + snapBand) continue;
    const rx = dx - axial * cyl.axis[0];
    const ry = dy - axial * cyl.axis[1];
    const rz = dz - axial * cyl.axis[2];
    const radialDist = Math.hypot(rx, ry, rz);
    const err = Math.abs(radialDist - cyl.radius);
    const tol = Math.max(0.25, cyl.rmsError * 4, part.mesh.diagonal * 0.008);
    if (err <= tol && err < bestCylErr) {
      bestCylErr = err;
      bestCyl = cyl;
    }
  }

  if (bestCyl) {
    const feat = index.featureById.get(bestCyl.id) ?? null;
    if (feat) {
      return { reference: featureToMeasurementReference(feat), feature: feat };
    }
  }

  // 3. Check planar faces matching plane distance & normal alignment
  let bestPlane: PlanarRegion | null = null;
  let bestPlaneScore = Infinity;
  const planeTol = Math.max(0.15, part.mesh.diagonal * 0.004);

  for (const plane of part.planes) {
    const dx = hitPoint[0] - plane.planePoint[0];
    const dy = hitPoint[1] - plane.planePoint[1];
    const dz = hitPoint[2] - plane.planePoint[2];
    const dist = Math.abs(
      dx * plane.planeNormal[0] + dy * plane.planeNormal[1] + dz * plane.planeNormal[2]
    );
    if (dist > planeTol) continue;

    // Bounding-box check with margin
    const m = planeTol * 2;
    if (
      hitPoint[0] < plane.bboxMin[0] - m ||
      hitPoint[0] > plane.bboxMax[0] + m ||
      hitPoint[1] < plane.bboxMin[1] - m ||
      hitPoint[1] > plane.bboxMax[1] + m ||
      hitPoint[2] < plane.bboxMin[2] - m ||
      hitPoint[2] > plane.bboxMax[2] + m
    ) {
      continue;
    }

    if (hitNormal) {
      const nDot =
        hitNormal[0] * plane.planeNormal[0] +
        hitNormal[1] * plane.planeNormal[1] +
        hitNormal[2] * plane.planeNormal[2];
      if (Math.abs(nDot) < 0.85) continue;
    }

    if (dist < bestPlaneScore) {
      bestPlaneScore = dist;
      bestPlane = plane;
    }
  }

  if (bestPlane) {
    const feat = index.featureById.get(bestPlane.id) ?? null;
    if (feat) {
      return {
        reference: {
          ...featureToMeasurementReference(feat),
          triangleIndices: bestPlane.triangleIndices,
        },
        feature: feat,
      };
    }
  }

  return {
    reference: {
      kind: 'point',
      partId,
      position: hitPoint,
      ...(hitNormal ? { normal: hitNormal } : {}),
    },
    feature: null,
  };
}

// ============================================================================
// Client LocalStorage Cache Helpers
// ============================================================================

function featureCacheKey(fileId: string, versionId: string): string {
  return `cadline.features.v${FEATURE_CACHE_SCHEMA_VERSION}:${fileId}:${versionId}`;
}

export function readLocalFeatureCache(
  fileId: string,
  versionId: string
): FileFeaturesCacheData | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(featureCacheKey(fileId, versionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FileFeaturesCacheData;
    if (
      !parsed ||
      parsed.version !== FEATURE_CACHE_SCHEMA_VERSION ||
      !Array.isArray(parsed.features)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalFeatureCache(
  fileId: string,
  versionId: string,
  data: FileFeaturesCacheData
): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(featureCacheKey(fileId, versionId), JSON.stringify(data));
  } catch {
    // Ignore storage quota errors
  }
}

export function toFeatureCachePayload(index: GeometryFeatureIndex): FileFeaturesCacheData {
  return {
    version: FEATURE_CACHE_SCHEMA_VERSION,
    extractedAt: new Date().toISOString(),
    features: index.features,
    partSummaries: index.partSummaries,
  };
}
