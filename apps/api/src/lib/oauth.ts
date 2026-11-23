/**
 * OAuth Provider Interface Stubs (Google & Microsoft)
 *
 * Session 1 defines the provider contract and disabled stub implementations.
 * Live OAuth2 / OIDC authorization-code exchange and state validation will plug
 * into this interface once client credentials are provisioned.
 */

export type OAuthProviderName = 'google' | 'microsoft';

export interface OAuthProfile {
  provider: OAuthProviderName;
  subject: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface OAuthProvider {
  readonly name: OAuthProviderName;
  isConfigured(): boolean;
  getAuthorizationUrl(state: string, redirectUri: string): string;
  exchangeCodeForProfile(code: string, redirectUri: string): Promise<OAuthProfile>;
}

class StubOAuthProvider implements OAuthProvider {
  constructor(
    public readonly name: OAuthProviderName,
    private readonly clientIdEnvKey: string
  ) {}

  isConfigured(): boolean {
    return Boolean(process.env[this.clientIdEnvKey]);
  }

  getAuthorizationUrl(_state: string, _redirectUri: string): string {
    throw new Error(
      `OAuth provider "${this.name}" is stubbed in Session 1. Configure ${this.clientIdEnvKey} and implement token exchange in a later session.`
    );
  }

  async exchangeCodeForProfile(
    _code: string,
    _redirectUri: string
  ): Promise<OAuthProfile> {
    throw new Error(
      `OAuth provider "${this.name}" code exchange is not enabled in Session 1.`
    );
  }
}

export const oauthProviders: Record<OAuthProviderName, OAuthProvider> = {
  google: new StubOAuthProvider('google', 'OAUTH_GOOGLE_CLIENT_ID'),
  microsoft: new StubOAuthProvider('microsoft', 'OAUTH_MICROSOFT_CLIENT_ID'),
};
