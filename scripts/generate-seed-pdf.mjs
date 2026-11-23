#!/usr/bin/env node
/**
 * Generates scripts/seed-models/sample-sheet.pdf:
 * A clean 1-page A4 landscape vector engineering drawing (842 x 595 pt)
 * matching plate-150x100.dxf (150x100 mm mounting plate, 4x dia 8 holes on 120x70 pattern,
 * central bore, centerlines, dimensions, and title block).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, 'seed-models/sample-sheet.pdf');

// 1 mm = 2.83465 pt
const MM = 72 / 25.4;
const pageW = 841.89; // 297 mm
const pageH = 595.28; // 210 mm

// Map DXF model coords (plate 0..150, 0..100 inside A4 -35..262, -35..175) to PDF points
const ox = 35 * MM;
const oy = 35 * MM;
const px = (x) => (ox + x * MM).toFixed(2);
const py = (y) => (oy + y * MM).toFixed(2);

function circlePath(cx, cy, r) {
  const k = 0.5522847498 * r;
  return [
    `${px(cx + r)} ${py(cy)} m`,
    `${px(cx + r)} ${py(cy + k)} ${px(cx + k)} ${py(cy + r)} ${px(cx)} ${py(cy + r)} c`,
    `${px(cx - k)} ${py(cy + r)} ${px(cx - r)} ${py(cy + k)} ${px(cx - r)} ${py(cy)} c`,
    `${px(cx - r)} ${py(cy - k)} ${px(cx - k)} ${py(cy - r)} ${px(cx)} ${py(cy - r)} c`,
    `${px(cx + k)} ${py(cy - r)} ${px(cx + r)} ${py(cy - k)} ${px(cx + r)} ${py(cy)} c`,
    'S',
  ].join('\n');
}

const cmds = [
  // White sheet background
  '1 1 1 rg',
  `0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)} re f`,

  // Outer A4 drawing border
  '0.12 0.16 0.24 RG',
  '1.2 w',
  `${px(-25)} ${py(-25)} ${(277 * MM).toFixed(2)} ${(190 * MM).toFixed(2)} re S`,

  // Title block
  '0.8 w',
  `${px(142)} ${py(-25)} ${(110 * MM).toFixed(2)} ${(30 * MM).toFixed(2)} re S`,
  `${px(142)} ${py(-10)} m ${px(252)} ${py(-10)} l S`,

  // Mounting plate outer rectangle 150x100 mm
  '0.06 0.09 0.16 RG',
  '1.8 w',
  `${px(0)} ${py(0)} ${(150 * MM).toFixed(2)} ${(100 * MM).toFixed(2)} re S`,

  // Central bore dia 32 mm
  circlePath(75, 50, 16),

  // 4 mounting holes dia 8 mm on 120x70 bolt pattern
  '0.05 0.45 0.28 RG',
  '1.4 w',
  circlePath(15, 15, 4),
  circlePath(135, 15, 4),
  circlePath(135, 85, 4),
  circlePath(15, 85, 4),

  // Centerlines (dashed red)
  '0.82 0.22 0.18 RG',
  '0.7 w',
  '[6 3 2 3] 0 d',
  `${px(-10)} ${py(50)} m ${px(160)} ${py(50)} l S`,
  `${px(75)} ${py(-10)} m ${px(75)} ${py(110)} l S`,
  // Bolt hole crosshairs
  `${px(9)} ${py(15)} m ${px(21)} ${py(15)} l S`,
  `${px(15)} ${py(9)} m ${px(15)} ${py(21)} l S`,
  `${px(129)} ${py(15)} m ${px(141)} ${py(15)} l S`,
  `${px(135)} ${py(9)} m ${px(135)} ${py(21)} l S`,
  `${px(129)} ${py(85)} m ${px(141)} ${py(85)} l S`,
  `${px(135)} ${py(79)} m ${px(135)} ${py(91)} l S`,
  `${px(9)} ${py(85)} m ${px(21)} ${py(85)} l S`,
  `${px(15)} ${py(79)} m ${px(15)} ${py(91)} l S`,
  '[] 0 d',

  // Dimension lines (blue)
  '0.04 0.37 0.95 RG',
  '0.8 w',
  // Horizontal 150 mm dim
  `${px(0)} ${py(102)} m ${px(0)} ${py(118)} l S`,
  `${px(150)} ${py(102)} m ${px(150)} ${py(118)} l S`,
  `${px(0)} ${py(114)} m ${px(150)} ${py(114)} l S`,
  // Vertical 100 mm dim
  `${px(152)} ${py(0)} m ${px(168)} ${py(0)} l S`,
  `${px(152)} ${py(100)} m ${px(168)} ${py(100)} l S`,
  `${px(164)} ${py(0)} m ${px(164)} ${py(100)} l S`,

  // Text annotations
  '0.04 0.37 0.95 rg',
  'BT /F1 11 Tf',
  `1 0 0 1 ${px(64)} ${py(117)} Tm (150.00 mm) Tj`,
  `1 0 0 1 ${px(167)} ${py(48)} Tm (100.00 mm) Tj`,
  'ET',

  // Title block text
  '0.08 0.12 0.18 rg',
  'BT /F1 13 Tf',
  `1 0 0 1 ${px(146)} ${py(-5)} Tm (MOUNTING PLATE 150x100) Tj`,
  'ET',
  'BT /F1 9 Tf',
  `1 0 0 1 ${px(146)} ${py(-16)} Tm (4x DIA 8.0 THRU ON 120x70 BOLT PATTERN) Tj`,
  `1 0 0 1 ${px(146)} ${py(-22)} Tm (SCALE 1:1  |  UNITS: MM  |  REV C  |  CADLINE) Tj`,
  'ET',
].join('\n');

const streamBuf = Buffer.from(cmds, 'utf8');

const objects = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  `5 0 obj\n<< /Length ${streamBuf.length} >>\nstream\n${cmds}\nendstream\nendobj\n`,
];

let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const obj of objects) {
  offsets.push(Buffer.byteLength(pdf, 'utf8'));
  pdf += obj;
}

const xrefStart = Buffer.byteLength(pdf, 'utf8');
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (let i = 1; i < offsets.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, pdf, 'utf8');
console.log(`Generated ${outPath} (${Buffer.byteLength(pdf, 'utf8')} bytes)`);
