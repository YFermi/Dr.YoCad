import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildTriangleMeshDataFromRawTriangles,
  extractTriangleMeshDataFromGeometry,
} from './meshData';
import { extractPlanarRegions } from './planarRegions';
import { extractBoundaryLoops, fitCircle2D } from './edgeLoops';

/**
 * Builds a clean planar 50x50 square face at z = 0 with a circular through-hole
 * of radius `holeRadius` centered at (0, 0) using `segments` radial slices.
 */
function buildPlateFaceWithHole(size: number, holeRadius: number, segments: number): number[] {
  const half = size / 2;
  const tris: number[] = [];

  // Map angle theta to point on outer square perimeter
  const squarePoint = (theta: number): [number, number] => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const scale = half / Math.max(Math.abs(c), Math.abs(s));
    return [c * scale, s * scale];
  };

  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * Math.PI * 2;
    const t1 = ((i + 1) / segments) * Math.PI * 2;
    const ix0 = Math.cos(t0) * holeRadius;
    const iy0 = Math.sin(t0) * holeRadius;
    const ix1 = Math.cos(t1) * holeRadius;
    const iy1 = Math.sin(t1) * holeRadius;

    const [ox0, oy0] = squarePoint(t0);
    const [ox1, oy1] = squarePoint(t1);

    // Two CCW triangles forming annular strip with normal +Z
    tris.push(ix0, iy0, 0, ox0, oy0, 0, ox1, oy1, 0);
    tris.push(ix0, iy0, 0, ox1, oy1, 0, ix1, iy1, 0);
  }
  return tris;
}

test('fitCircle2D recovers exact center and radius on 24-point circle', () => {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push([12.5 + Math.cos(a) * 5.0, -7.25 + Math.sin(a) * 5.0]);
  }
  const fit = fitCircle2D(pts);
  assert.ok(fit !== null);
  assert.ok(Math.abs(fit.cx - 12.5) < 1e-4);
  assert.ok(Math.abs(fit.cy - -7.25) < 1e-4);
  assert.ok(Math.abs(fit.radius - 5.0) < 1e-4);
  assert.ok(fit.rmsError < 1e-4);
});

test('extractBoundaryLoops classifies a 10mm circular hole as CIRCLE and outer square as POLYLINE', () => {
  const raw = buildPlateFaceWithHole(50, 5, 32);
  const mesh = buildTriangleMeshDataFromRawTriangles(raw, 'plate_face');
  const regions = extractPlanarRegions(mesh);
  assert.equal(regions.length, 1);

  const loops = extractBoundaryLoops(mesh, regions[0]);
  const circles = loops.filter((l) => l.kind === 'CIRCLE');
  const polylines = loops.filter((l) => l.kind === 'POLYLINE');

  assert.equal(circles.length, 1, `Expected 1 circular hole loop, got ${circles.length}`);
  assert.equal(polylines.length, 1, `Expected 1 square outer polyline, got ${polylines.length}`);
  assert.ok(Math.abs(circles[0].diameter - 10.0) < 0.05, `Got diameter ${circles[0].diameter}`);
  assert.equal(circles[0].isHole, true);
});

test('extractBoundaryLoops does NOT misclassify a subdivided square face as a CIRCLE', () => {
  const plane = new THREE.PlaneGeometry(50, 50, 4, 4);
  const mesh = extractTriangleMeshDataFromGeometry(plane, 'subdiv_square');
  const regions = extractPlanarRegions(mesh);
  assert.equal(regions.length, 1);

  const loops = extractBoundaryLoops(mesh, regions[0]);
  const circles = loops.filter((l) => l.kind === 'CIRCLE');
  assert.equal(circles.length, 0, 'Subdivided square must not be classified as CIRCLE');
});
