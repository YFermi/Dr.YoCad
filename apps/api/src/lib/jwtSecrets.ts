import crypto from 'node:crypto';

/**
 * Reads a JWT signing secret from the environment.
 *
 * - Production (NODE_ENV=production): a missing or empty value throws, so the
 *   process refuses to start instead of signing tokens with a known secret.
 * - Any other environment: falls back to a random per-process secret and logs
 *   a warning. Tokens issued before a restart stop validating after it.
 */
export function resolveJwtSecret(envName: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[envName]?.trim();
  if (value) return value;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${envName} is not set. Refusing to start in production without a JWT signing secret.`
    );
  }

  console.warn(
    `[auth] ${envName} is not set; using an ephemeral random secret for this process. ` +
      'Sessions will not survive a restart. Set it in .env to persist them.'
  );
  return crypto.randomBytes(48).toString('base64url');
}
