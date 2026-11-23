-- AlterTable: Add optional featuresJson cache column to ConversionJob (Session 7)
ALTER TABLE "ConversionJob"
  ADD COLUMN "featuresJson" JSONB;
