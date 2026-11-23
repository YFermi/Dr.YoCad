import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { extractTriangleMeshDataFromGeometry } from './meshData';
import { extractPlanarRegions } from './planarRegions';

test('extractPlanarRegions detects exactly 6 planar faces on a 50mm cube', () => {
  const box = new THREE.BoxGeometry(50, 50, 50);
  const mesh = extractTriangleMeshDataFromGeometry(box, 'cube_50', 'Cube 50mm');
  const regions = extractPlanarRegions(mesh);

  assert.equal(regions.length, 6, `Expected 6 planar faces, got ${regions.length}`);
  for (const r of regions) {
    assert.ok(
      Math.abs(r.area - 2500) < 1e-2,
      `Expected face area ~2500 mm^2, got ${r.area}`
    );
    assert.equal(r.triangleCount, 2);
    assert.ok(Math.abs(r.extentU - 50) < 1e-2);
    assert.ok(Math.abs(r.extentV - 50) < 1e-2);
  }
});

test('extractPlanarRegions merges subdivided coplanar faces into 6 regions', () => {
  const box = new THREE.BoxGeometry(50, 30, 20, 4, 4, 4);
  const mesh = extractTriangleMeshDataFromGeometry(box, 'subdiv_box', 'Subdivided Box');
  const regions = extractPlanarRegions(mesh);

  assert.equal(regions.length, 6, `Expected 6 merged planar faces, got ${regions.length}`);
  const areas = regions.map((r) => Math.round(r.area)).sort((a, b) => a - b);
  assert.deepEqual(areas, [600, 600, 1000, 1000, 1500, 1500]);
});
