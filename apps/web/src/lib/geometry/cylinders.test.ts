import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { extractTriangleMeshDataFromGeometry } from './meshData';
import { extractPlanarRegions } from './planarRegions';
import { extractCylinders } from './cylinders';

test('extractCylinders detects a 32-segment cylinder (radius 8mm, height 40mm)', () => {
  const cylGeom = new THREE.CylinderGeometry(8, 8, 40, 32, 1, false);
  const mesh = extractTriangleMeshDataFromGeometry(cylGeom, 'shaft_16');
  const planes = extractPlanarRegions(mesh);
  const cylinders = extractCylinders(mesh, planes);

  assert.equal(cylinders.length, 1, `Expected 1 cylinder, got ${cylinders.length}`);
  assert.ok(
    Math.abs(cylinders[0].radius - 8) < 0.1,
    `Expected radius ~8, got ${cylinders[0].radius}`
  );
  assert.ok(
    Math.abs(cylinders[0].diameter - 16) < 0.2,
    `Expected diameter ~16, got ${cylinders[0].diameter}`
  );
  assert.ok(
    Math.abs(cylinders[0].length - 40) < 0.1,
    `Expected length ~40, got ${cylinders[0].length}`
  );
  assert.equal(cylinders[0].isConcave, false);
});

test('extractCylinders recovers axis and radius on a tilted cylinder', () => {
  const cylGeom = new THREE.CylinderGeometry(5, 5, 25, 24, 1, false);
  const matrix = new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler(0.6, 0.4, -0.3))
    .setPosition(10, -5, 8);
  const mesh = extractTriangleMeshDataFromGeometry(cylGeom, 'tilted_pin', 'Tilted Pin', matrix);
  const planes = extractPlanarRegions(mesh);
  const cylinders = extractCylinders(mesh, planes);

  assert.equal(cylinders.length, 1, `Expected 1 tilted cylinder, got ${cylinders.length}`);
  assert.ok(Math.abs(cylinders[0].diameter - 10) < 0.15);
  assert.ok(Math.abs(cylinders[0].length - 25) < 0.15);
});

test('extractCylinders does NOT classify a cone or sphere as a cylinder', () => {
  const cone = new THREE.ConeGeometry(10, 30, 32);
  const coneMesh = extractTriangleMeshDataFromGeometry(cone, 'cone_test');
  const coneCyls = extractCylinders(coneMesh, extractPlanarRegions(coneMesh));
  assert.equal(coneCyls.length, 0, 'Cone should not be classified as cylinder');

  const sphere = new THREE.SphereGeometry(15, 24, 16);
  const sphereMesh = extractTriangleMeshDataFromGeometry(sphere, 'sphere_test');
  const sphereCyls = extractCylinders(sphereMesh, extractPlanarRegions(sphereMesh));
  assert.equal(sphereCyls.length, 0, 'Sphere should not be classified as cylinder');
});
