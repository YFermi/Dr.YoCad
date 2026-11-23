import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { MeasurementReference } from '@cadline/shared';
import { extractTriangleMeshDataFromGeometry } from './meshData';
import {
  anglePlanePlane,
  autoResolveSmartMeasurement,
  centerToCenter,
  computePartArea,
  computePartBbox,
  computePartVolumeAndCentroid,
  convertSmartMeasurementUnit,
  diameterCircleOrCylinder,
  distancePlanePlane,
  distancePointPlane,
  distancePointPoint,
  minWallBetween,
} from './measurements';

test('distancePointPoint and distancePointPlane match analytical values', () => {
  const pA: MeasurementReference = { kind: 'point', partId: 'p1', position: [0, 0, 0] };
  const pB: MeasurementReference = { kind: 'point', partId: 'p1', position: [3, 4, 12] };
  const d = distancePointPoint(pA, pB);
  assert.ok(Math.abs(d.value - 13) < 1e-4);

  const plane: MeasurementReference = {
    kind: 'plane',
    partId: 'p1',
    position: [0, 0, 10],
    normal: [0, 0, 1],
  };
  const dp = distancePointPlane(pA, plane);
  assert.ok(Math.abs(dp.value - 10) < 1e-4);
});

test('distancePlanePlane returns perpendicular distance for parallel faces and angle for non-parallel faces', () => {
  const top: MeasurementReference = {
    kind: 'plane',
    partId: 'cube',
    position: [0, 25, 0],
    normal: [0, 1, 0],
  };
  const bottom: MeasurementReference = {
    kind: 'plane',
    partId: 'cube',
    position: [12, -25, -4],
    normal: [0, -1, 0],
  };
  const side: MeasurementReference = {
    kind: 'plane',
    partId: 'cube',
    position: [25, 0, 0],
    normal: [1, 0, 0],
  };

  const parRes = distancePlanePlane(top, bottom);
  assert.equal(parRes.parallel, true);
  assert.equal(parRes.measurement.kind, 'distance');
  assert.ok(Math.abs(parRes.measurement.value - 50) < 1e-3);

  const perpRes = distancePlanePlane(top, side);
  assert.equal(perpRes.parallel, false);
  assert.equal(perpRes.measurement.kind, 'angle');
  assert.ok(Math.abs(perpRes.measurement.value - 90) < 1e-3);

  const ang = anglePlanePlane(top, side);
  assert.ok(Math.abs(ang.value - 90) < 1e-3);
});

test('diameterCircleOrCylinder and centerToCenter return accurate values and related diameters', () => {
  const holeA: MeasurementReference = {
    kind: 'circle',
    partId: 'plate',
    position: [-15, 0, 5],
    normal: [0, 0, 1],
    radius: 5,
  };
  const holeB: MeasurementReference = {
    kind: 'circle',
    partId: 'plate',
    position: [15, 0, 5],
    normal: [0, 0, 1],
    radius: 4,
  };

  const dia = diameterCircleOrCylinder(holeA);
  assert.equal(dia.kind, 'diameter');
  assert.ok(Math.abs(dia.value - 10) < 1e-4);

  const c2c = centerToCenter(holeA, holeB);
  assert.equal(c2c.primary.kind, 'center-to-center');
  assert.ok(Math.abs(c2c.primary.value - 30) < 1e-4);
  assert.equal(c2c.related.length, 2);
  assert.ok(Math.abs(c2c.related[0].value - 10) < 1e-4);
  assert.ok(Math.abs(c2c.related[1].value - 8) < 1e-4);
});

test('computePartBbox, computePartArea, computePartVolumeAndCentroid, and minWallBetween on 50mm cube and spaced plates', () => {
  const cube = extractTriangleMeshDataFromGeometry(new THREE.BoxGeometry(50, 50, 50), 'cube');
  const bbox = computePartBbox(cube);
  assert.deepEqual(bbox.bboxDims, [50, 50, 50]);

  const area = computePartArea(cube);
  assert.ok(Math.abs(area.value - 15000) < 1, `Expected 15000 mm^2, got ${area.value}`);

  const { volume, centroid } = computePartVolumeAndCentroid(cube);
  assert.ok(Math.abs(volume - 125000) < 10, `Expected 125000 mm^3, got ${volume}`);
  assert.ok(Math.hypot(centroid[0], centroid[1], centroid[2]) < 1e-3);

  // Same-part min wall on a 50x50x10 plate should be 10mm
  const plate = extractTriangleMeshDataFromGeometry(new THREE.BoxGeometry(50, 50, 10), 'plate');
  const sameWall = minWallBetween(plate, plate);
  assert.ok(sameWall !== null);
  assert.ok(Math.abs(sameWall.value - 10) < 0.05, `Expected 10mm wall, got ${sameWall.value}`);

  // Two parts separated by 7.5mm gap
  const partA = extractTriangleMeshDataFromGeometry(
    new THREE.BoxGeometry(20, 20, 10),
    'partA',
    'Part A',
    new THREE.Matrix4().makeTranslation(0, 0, 0)
  );
  const partB = extractTriangleMeshDataFromGeometry(
    new THREE.BoxGeometry(20, 20, 10),
    'partB',
    'Part B',
    new THREE.Matrix4().makeTranslation(27.5, 0, 0)
  );
  const gap = minWallBetween(partA, partB);
  assert.ok(gap !== null);
  assert.ok(Math.abs(gap.value - 7.5) < 0.05, `Expected 7.5mm gap, got ${gap.value}`);

  // Smart auto-resolver + unit conversion mm -> in
  const resolved = autoResolveSmartMeasurement(
    [{ kind: 'part', partId: 'cube', position: [0, 0, 0] }],
    { partMeshes: new Map([['cube', cube]]) }
  );
  assert.equal(resolved.primary?.kind, 'bbox');
  assert.equal(resolved.related.length, 2);

  const inConverted = convertSmartMeasurementUnit(
    distancePointPoint(
      { kind: 'point', partId: 'p', position: [0, 0, 0] },
      { kind: 'point', partId: 'p', position: [25.4, 0, 0] }
    ),
    'in'
  );
  assert.equal(inConverted.unit, 'in');
  assert.ok(Math.abs(inConverted.value - 1) < 1e-3);
});
