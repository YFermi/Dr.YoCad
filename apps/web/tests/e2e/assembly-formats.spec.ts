import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * STEP assemblies in the viewer and SolidWorks rejection at upload.
 * Runs against STANDALONE mode (no auth header needed for the API calls).
 */

const API = 'http://localhost:4000/api/v1';
const FIXTURE = path.resolve(import.meta.dirname, '../../../../scripts/seed-models/gearbox-assembly.step');
const SOLIDWORKS_MESSAGE =
  'SolidWorks native files (.sldprt/.sldasm) require a commercial converter. Export your file to STEP (.step) from SolidWorks, then upload that instead.';

/** Browser-style upload: init -> PUT the single part -> complete -> wait for READY/FAILED. */
async function uploadFile(request: APIRequestContext, filePath: string, fileName: string) {
  const bytes = fs.readFileSync(filePath);
  const init = await (
    await request.post(`${API}/files/init`, {
      data: { projectId: 'prj_demo_gearbox', fileName, mimeType: 'application/step', sizeBytes: bytes.length, chunkSize: 5 * 1024 * 1024 },
    })
  ).json();
  const put = await request.put(init.data.presignedUrls[0].url, { data: bytes });
  const etag = (put.headers()['etag'] ?? '').replace(/"/g, '');
  await request.post(`${API}/files/${init.data.file.id}/complete`, {
    data: { uploadId: init.data.uploadId, parts: [{ partNumber: 1, etag }] },
  });
  await expect
    .poll(async () => (await (await request.get(`${API}/files/${init.data.file.id}/status`)).json()).data.status, {
      timeout: 60_000,
    })
    .toMatch(/READY|FAILED/);
  return init.data.file.id as string;
}

test.describe('STEP assemblies', () => {
  let fileId: string;

  test.beforeAll(async ({ request }) => {
    fileId = await uploadFile(request, FIXTURE, `e2e-gearbox-${Date.now()}.step`);
  });

  test('tree, part counts, colors and sub-assembly inspection', async ({ page }) => {
    await page.goto(`/files/${fileId}`);
    await page.waitForFunction(() => window.__viewer?.getModelRoot() != null, null, { timeout: 60_000 });

    // Header badge and per-assembly counts in the model tree
    await expect(page.getByTestId('assembly-parts-badge')).toHaveText('Parts: 5');
    await expect(page.getByTitle('5 parts in this assembly')).toBeVisible();
    await expect(page.getByTitle('3 parts in this assembly')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide GEAR (2)' })).toBeVisible();

    // 5 meshes, 4 distinct parts -> 4 distinct colors (both GEAR instances share one)
    const colors = await page.evaluate(() => {
      const out: Record<string, string> = {};
      window.__viewer!.getModelRoot()!.traverse((o) => {
        const mesh = o as unknown as { isMesh?: boolean; name: string; parent: { name: string } | null; material: { color: { getHexString(): string } } };
        if (mesh.isMesh) out[mesh.name || mesh.parent?.name || String(Object.keys(out).length)] = mesh.material.color.getHexString();
      });
      return Object.values(out);
    });
    expect(colors).toHaveLength(5);
    expect(new Set(colors).size).toBe(4);

    // Inspecting the sub-assembly aggregates its 3 parts (18 planar faces)
    await page.getByRole('button', { name: 'Measure SHAFT_ASSY' }).click();
    await expect(page.getByText('FEATURES (18)')).toBeVisible();
    await expect(page.getByText('100.00 × 30.00 × 10.00 mm')).toBeVisible();
  });
});

test('SolidWorks files are rejected before upload', async ({ page }) => {
  const initRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/files/init')) initRequests.push(req.url());
  });
  await page.goto('/projects/prj_demo_gearbox');
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'bracket.SLDPRT', mimeType: 'application/octet-stream', buffer: Buffer.from('fake') },
    { name: 'gearbox.sldasm', mimeType: 'application/octet-stream', buffer: Buffer.from('fake') },
  ]);

  const modal = page.getByTestId('solidworks-rejection');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(SOLIDWORKS_MESSAGE);
  await expect(modal).toContainText('bracket.SLDPRT');
  await expect(modal.getByRole('link', { name: /export from SolidWorks/ })).toHaveAttribute(
    'href',
    /#exporting-from-solidworks$/
  );
  await modal.getByRole('button', { name: 'OK' }).click();
  await expect(modal).toBeHidden();
  expect(initRequests).toHaveLength(0);
});
