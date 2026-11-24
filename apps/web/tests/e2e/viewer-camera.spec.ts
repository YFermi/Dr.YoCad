import { expect, test, type Page } from '@playwright/test';

/**
 * Free camera + view cube on the seeded STEP fixture (50 mm cube centred at the
 * origin). Reads the main camera through `window.__viewer` (dev builds only).
 */

type Vec3 = [number, number, number];
interface CamState {
  pos: Vec3;
  up: Vec3;
  dir: Vec3;
  pivot: Vec3 | null;
  center: Vec3;
}

const STEP_FILE = '/files/fil_demo_housing';
const HALF = 25; // cube-50mm.step half-size

async function openStep(page: Page) {
  await page.goto(STEP_FILE);
  await page.waitForFunction(
    () => window.__viewer?.getModelCenter() != null && typeof window.__viewer?.viewCubePoint === 'function',
    null,
    { timeout: 60_000 }
  );
  await page.waitForTimeout(500); // initial framing settles
}

function camState(page: Page): Promise<CamState> {
  return page.evaluate(() => {
    const v = window.__viewer!;
    const c = v.camera;
    const t = (p: { x: number; y: number; z: number }): [number, number, number] => [p.x, p.y, p.z];
    const pivot = v.getPivot();
    return {
      pos: t(c.position),
      up: t(c.up),
      dir: t(c.getWorldDirection(c.position.clone())),
      pivot: pivot ? t(pivot) : null,
      center: t(v.getModelCenter()!),
    };
  });
}

/** Client (page) coordinates of a world point on the main canvas. */
async function toScreen(page: Page, p: Vec3) {
  const box = (await page.getByTestId('viewer-3d-canvas').boundingBox())!;
  return page.evaluate(
    ([pt, b]) => {
      const c = window.__viewer!.camera;
      const v = c.position.clone().set(pt[0], pt[1], pt[2]).project(c);
      return { x: b.x + ((v.x + 1) / 2) * b.width, y: b.y + ((1 - v.y) / 2) * b.height };
    },
    [p, box] as const
  );
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, button: 'left' | 'middle' = 'left') {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up({ button });
}

async function canvasCenter(page: Page) {
  const box = (await page.getByTestId('viewer-3d-canvas').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test.describe('3D viewer camera', () => {
  test('left-drag orbits; view cube Top looks straight down', async ({ page }) => {
    await openStep(page);
    const before = await camState(page);

    const { x, y } = await canvasCenter(page);
    await drag(page, { x, y }, { x: x + 220, y: y + 40 });
    const after = await camState(page);
    expect(dist(before.pos, after.pos)).toBeGreaterThan(1);

    const top = await page.evaluate(() => window.__viewer!.viewCubePoint!('top'));
    expect(top).not.toBeNull();
    await page.mouse.click(top!.x, top!.y);
    await page.waitForTimeout(700); // 400 ms animation

    const s = await camState(page);
    // Looking straight down the -Y axis
    expect(s.dir[0]).toBeCloseTo(0, 3);
    expect(s.dir[1]).toBeCloseTo(-1, 3);
    expect(s.dir[2]).toBeCloseTo(0, 3);
    // Cube clicks reset the pivot to the model centre
    expect(dist(s.pivot!, s.center)).toBeLessThan(1e-6);
  });

  test('roll persists: no snap back to upright', async ({ page }) => {
    await openStep(page);
    const { x, y, box } = await canvasCenter(page);
    const R = Math.min(box.width, box.height) * 0.45;
    // Arc drag near the viewport edge = roll about the view axis
    await page.mouse.move(x + R, y);
    await page.mouse.down();
    for (let a = 0; a <= 90; a += 5) {
      await page.mouse.move(x + R * Math.cos((a * Math.PI) / 180), y + R * Math.sin((a * Math.PI) / 180));
    }
    await page.mouse.up();
    const rolled = await camState(page);
    // Up vector is far from world-up: the view is rolled
    expect(rolled.up[1]).toBeLessThan(0.5);

    await page.waitForTimeout(1500);
    const idle = await camState(page);
    expect(idle.up).toEqual(rolled.up);
    expect(idle.pos).toEqual(rolled.pos);
  });

  test('dragging from a model corner pivots around that corner', async ({ page }) => {
    await openStep(page);
    const s0 = await camState(page);
    // Corner of the front (+Z) face nearest the camera, nudged onto the face.
    const corner: Vec3 = [
      s0.center[0] + Math.sign(s0.pos[0]) * HALF * 0.92,
      s0.center[1] + Math.sign(s0.pos[1]) * HALF * 0.92,
      s0.center[2] + Math.sign(s0.pos[2]) * HALF,
    ];
    const start = await toScreen(page, corner);
    await drag(page, start, { x: start.x + 160, y: start.y - 60 });

    const s1 = await camState(page);
    expect(dist(s1.pivot!, corner)).toBeLessThan(0.5);
    const end = await toScreen(page, corner);
    // The pivot point stays put on screen while the camera turns around it
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeLessThan(2);
  });

  test('wheel zooms toward the point under the cursor', async ({ page }) => {
    await openStep(page);
    const s0 = await camState(page);
    const point: Vec3 = [
      s0.center[0] + Math.sign(s0.pos[0]) * HALF * 0.5,
      s0.center[1] - Math.sign(s0.pos[1]) * HALF * 0.3,
      s0.center[2] + Math.sign(s0.pos[2]) * HALF,
    ];
    const at = await toScreen(page, point);
    await page.mouse.move(at.x, at.y);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(40);
    }
    const s1 = await camState(page);
    expect(dist(s1.pos, point)).toBeLessThan(dist(s0.pos, point) * 0.7);
    const after = await toScreen(page, point);
    expect(Math.hypot(after.x - at.x, after.y - at.y)).toBeLessThan(2);
    // Zoom does not move the pivot
    expect(s1.pivot).toEqual(s0.pivot);
  });
});
