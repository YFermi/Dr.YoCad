import type { ApiResponse, AuthSession } from '@cadline/shared';

export const API_BASE_URL =
  import.meta.env.VITE_API_URL ?? '/api/v1';

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface AuthHandlerBridge {
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  onTokensRefreshed: (session: AuthSession) => void;
  onAuthFailure: () => void;
}

let authBridge: AuthHandlerBridge | null = null;
let socketIdProvider: (() => string | null) | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export function registerAuthHandlers(handlers: AuthHandlerBridge): void {
  authBridge = handlers;
}

export function registerSocketIdProvider(provider: () => string | null): void {
  socketIdProvider = provider;
}

async function performTokenRefresh(): Promise<string | null> {
  if (!authBridge) return null;
  const refreshToken = authBridge.getRefreshToken();
  if (!refreshToken) return null;

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

        const payload = (await response.json()) as ApiResponse<AuthSession>;
        if (!response.ok || !payload.success || !payload.data) {
          authBridge?.onAuthFailure();
          return null;
        }

        authBridge?.onTokensRefreshed(payload.data);
        return payload.data.tokens.accessToken;
      } catch {
        authBridge?.onAuthFailure();
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }

  return refreshInFlight;
}

export interface ApiRequestOptions extends RequestInit {
  skipAuth?: boolean;
  shareToken?: string;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function apiFetch<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const { skipAuth = false, shareToken, headers: customHeaders, ...rest } = options;
  const method = (rest.method ?? 'GET').toUpperCase();

  const buildHeaders = (token: string | null): Headers => {
    const headers = new Headers(customHeaders);
    const isBinary =
      rest.body instanceof Blob ||
      rest.body instanceof ArrayBuffer ||
      rest.body instanceof FormData;

    if (!isBinary && rest.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    if (!skipAuth && token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    if (shareToken) {
      headers.set('x-share-token', shareToken);
    }

    if (MUTATING_METHODS.has(method) && !headers.has('x-socket-id')) {
      const socketId = socketIdProvider?.();
      if (socketId) {
        headers.set('x-socket-id', socketId);
      }
    }

    return headers;
  };

  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  const initialToken = skipAuth ? null : (authBridge?.getAccessToken() ?? null);

  let response = await fetch(url, {
    ...rest,
    headers: buildHeaders(initialToken),
  });

  if (response.status === 401 && !skipAuth && authBridge?.getRefreshToken()) {
    const refreshedToken = await performTokenRefresh();
    if (refreshedToken) {
      response = await fetch(url, {
        ...rest,
        headers: buildHeaders(refreshedToken),
      });
    }
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiClientError(
        'HTTP_ERROR',
        `Request failed with status ${response.status}`,
        response.status
      );
    }
    return undefined as T;
  }

  const payload = (await response.json()) as ApiResponse<T> & {
    code?: string;
    retryAfterSeconds?: number;
  };
  if (!response.ok || !payload.success) {
    const headerRetry = response.headers.get('Retry-After');
    const parsedHeaderRetry = headerRetry ? Number(headerRetry) : undefined;
    const retryAfterSeconds =
      payload.error?.retryAfterSeconds ??
      payload.retryAfterSeconds ??
      (parsedHeaderRetry && Number.isFinite(parsedHeaderRetry)
        ? parsedHeaderRetry
        : undefined);
    throw new ApiClientError(
      payload.error?.code ?? payload.code ?? 'REQUEST_FAILED',
      payload.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      retryAfterSeconds
    );
  }

  return payload.data as T;
}
