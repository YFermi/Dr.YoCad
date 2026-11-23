import { UserRole, type PrismaClient } from '@prisma/client';
import { seedDemoData, type DemoSeedStorage } from './demoData.js';
import { LOCAL_ORGANIZATION, LOCAL_USER } from './standalone.js';

/**
 * STANDALONE first boot: creates the fixed local organization and LOCAL_USER
 * plus the regular demo dataset (2 demo users, gearbox project, STEP/STL/DXF/PDF
 * fixtures) inside that organization, so the local user sees the demo project.
 * Returns false when the database was already seeded.
 */
export async function seedStandaloneIfEmpty(
  prisma: PrismaClient,
  storage: DemoSeedStorage
): Promise<boolean> {
  const existing = await prisma.organization.findUnique({ where: { id: LOCAL_ORGANIZATION.id } });
  if (existing) return false;

  await seedDemoData(prisma, storage, {
    organization: { ...LOCAL_ORGANIZATION },
    extraUsers: [
      {
        id: LOCAL_USER.id,
        email: LOCAL_USER.email,
        name: LOCAL_USER.name,
        role: UserRole.OWNER,
      },
    ],
  });
  return true;
}
