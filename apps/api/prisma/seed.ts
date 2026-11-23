import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ensureBucket, uploadObjectBuffer } from '../src/lib/s3.js';
import { seedDemoData } from '../src/lib/demoData.js';

const prisma = new PrismaClient();

async function main() {
  const result = await seedDemoData(prisma, { ensureBucket, uploadObjectBuffer });
  console.log('Seed completed: sample models uploaded to S3 and conversion jobs queued:', result);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
