-- AlterTable: Add 2D drawing conversion fields to ConversionJob
ALTER TABLE "ConversionJob"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT '3D',
  ADD COLUMN "sceneKey" TEXT,
  ADD COLUMN "layerManifest" JSONB,
  ADD COLUMN "bounds" JSONB,
  ADD COLUMN "pageManifest" JSONB;
