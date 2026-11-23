import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient, FileStatus, UserRole } from '@prisma/client';
import { ensureBucket, uploadObjectBuffer } from '../src/lib/s3.js';

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_MODELS_DIR = path.resolve(__dirname, '../../../scripts/seed-models');

async function main() {
  await ensureBucket();
  const passwordHash = await bcrypt.hash('Password123!', 12);

  const org = await prisma.organization.upsert({
    where: { slug: 'demo-engineering' },
    update: {},
    create: {
      id: 'org_demo_engineering',
      name: 'Demo Engineering',
      slug: 'demo-engineering',
    },
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@demo.local' },
    update: {},
    create: {
      id: 'usr_demo_admin',
      organizationId: org.id,
      email: 'admin@demo.local',
      passwordHash,
      name: 'Alex Morgan',
      role: UserRole.ADMIN,
    },
  });

  await prisma.user.upsert({
    where: { email: 'user@demo.local' },
    update: {},
    create: {
      id: 'usr_demo_member',
      organizationId: org.id,
      email: 'user@demo.local',
      passwordHash,
      name: 'Samira Chen',
      role: UserRole.MEMBER,
    },
  });

  const project = await prisma.project.upsert({
    where: { id: 'prj_demo_gearbox' },
    update: {},
    create: {
      id: 'prj_demo_gearbox',
      organizationId: org.id,
      createdById: admin.id,
      name: 'Planetary Gearbox Assembly',
      description:
        'Calibration cube STEP & STL reference assets ready for interactive 3D inspection.',
    },
  });

  const rootFolder = await prisma.folder.upsert({
    where: { id: 'fld_demo_assemblies' },
    update: {},
    create: {
      id: 'fld_demo_assemblies',
      projectId: project.id,
      name: 'Assemblies',
    },
  });

  const stepBuffer = fs.readFileSync(path.join(SEED_MODELS_DIR, 'cube-50mm.step'));
  const stlBuffer = fs.readFileSync(path.join(SEED_MODELS_DIR, 'cube-50mm.stl'));
  const dxfBuffer = fs.readFileSync(path.join(SEED_MODELS_DIR, 'plate-150x100.dxf'));
  const pdfBuffer = fs.readFileSync(path.join(SEED_MODELS_DIR, 'sample-sheet.pdf'));

  const fileRecords = [
    {
      id: 'fil_demo_housing',
      versionId: 'ver_demo_housing_v1',
      name: 'calibration-cube-50mm.step',
      originalName: 'calibration-cube-50mm.step',
      mimeType: 'application/step',
      extension: 'step',
      buffer: stepBuffer,
      storageKey: `orgs/${org.id}/projects/${project.id}/fil_demo_housing/v1/calibration-cube-50mm.step`,
    },
    {
      id: 'fil_demo_carrier',
      versionId: 'ver_demo_carrier_v1',
      name: 'calibration-cube-50mm.stl',
      originalName: 'calibration-cube-50mm.stl',
      mimeType: 'model/stl',
      extension: 'stl',
      buffer: stlBuffer,
      storageKey: `orgs/${org.id}/projects/${project.id}/fil_demo_carrier/v1/calibration-cube-50mm.stl`,
    },
    {
      id: 'fil_demo_plate_dxf',
      versionId: 'ver_demo_plate_dxf_v1',
      name: 'plate-150x100.dxf',
      originalName: 'plate-150x100.dxf',
      mimeType: 'application/dxf',
      extension: 'dxf',
      buffer: dxfBuffer,
      storageKey: `orgs/${org.id}/projects/${project.id}/fil_demo_plate_dxf/v1/plate-150x100.dxf`,
    },
    {
      id: 'fil_demo_sheet_pdf',
      versionId: 'ver_demo_sheet_pdf_v1',
      name: 'sample-sheet.pdf',
      originalName: 'sample-sheet.pdf',
      mimeType: 'application/pdf',
      extension: 'pdf',
      buffer: pdfBuffer,
      storageKey: `orgs/${org.id}/projects/${project.id}/fil_demo_sheet_pdf/v1/sample-sheet.pdf`,
    },
  ];

  for (const record of fileRecords) {
    await uploadObjectBuffer(record.storageKey, record.buffer, record.mimeType);

    await prisma.file.upsert({
      where: { id: record.id },
      update: {
        name: record.name,
        originalName: record.originalName,
        mimeType: record.mimeType,
        extension: record.extension,
        sizeBytes: record.buffer.byteLength,
        status: FileStatus.PROCESSING,
      },
      create: {
        id: record.id,
        projectId: project.id,
        folderId: rootFolder.id,
        uploadedById: admin.id,
        name: record.name,
        originalName: record.originalName,
        mimeType: record.mimeType,
        extension: record.extension,
        sizeBytes: record.buffer.byteLength,
        status: FileStatus.PROCESSING,
        currentVersion: 1,
      },
    });

    const version = await prisma.fileVersion.upsert({
      where: {
        fileId_versionNumber: {
          fileId: record.id,
          versionNumber: 1,
        },
      },
      update: {
        storageKey: record.storageKey,
        sizeBytes: record.buffer.byteLength,
        status: FileStatus.PROCESSING,
      },
      create: {
        id: record.versionId,
        fileId: record.id,
        versionNumber: 1,
        storageKey: record.storageKey,
        sizeBytes: record.buffer.byteLength,
        status: FileStatus.PROCESSING,
        uploadedById: admin.id,
      },
    });

    await prisma.conversionJob.upsert({
      where: { fileVersionId: version.id },
      update: {
        status: 'QUEUED',
        error: null,
      },
      create: {
        fileVersionId: version.id,
        status: 'QUEUED',
      },
    });
  }

  console.log('Seed completed: sample models uploaded to S3 and conversion jobs queued:', {
    organization: org.slug,
    users: ['admin@demo.local', 'user@demo.local'],
    project: project.name,
    files: fileRecords.map((f) => `${f.name} (${f.buffer.byteLength} B)`),
  });
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
