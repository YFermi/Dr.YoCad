import { create } from 'zustand';
import type { AuthSession, AuthTokens, Organization, User } from '@cadline/shared';
import { apiFetch, registerAuthHandlers } from './api';
import { clearPersistedAiChats } from '@/stores/aiStore';
import {
  LOCAL_ORGANIZATION,
  LOCAL_USER,
  STANDALONE,
  STANDALONE_ACCESS_TOKEN,
} from './standalone';

const STORAGE_KEY = 'cadline.auth.v1';

interface PersistedTokens {
  accessToken: string;
  refreshToken: string;
}

function readStoredTokens(): PersistedTokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedTokens>;
    if (parsed.accessToken && parsed.refreshToken) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredTokens(tokens: PersistedTokens | null): void {
  try {
    if (!tokens) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    }
  } catch {
    // Ignore storage errors in restricted browsing contexts
  }
}

interface AuthState {
  user: User | null;
  organization: Organization | null;
  accessToken: string | null;
  refreshToken: string | null;
  isHydrated: boolean;
  isLoading: boolean;
  setTokens: (tokens: AuthTokens) => void;
  setSession: (session: AuthSession) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
    organizationName?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  hydrate: () => Promise<void>;
}

// STANDALONE: no stored session; the store starts signed in as the fixed
// local user (see ./standalone.ts) and never calls the auth API.
const initialTokens = STANDALONE ? null : readStoredTokens();

export const useAuthStore = create<AuthState>((set, get) => ({
  user: STANDALONE ? LOCAL_USER : null,
  organization: STANDALONE ? LOCAL_ORGANIZATION : null,
  accessToken: STANDALONE ? STANDALONE_ACCESS_TOKEN : (initialTokens?.accessToken ?? null),
  refreshToken: initialTokens?.refreshToken ?? null,
  isHydrated: STANDALONE,
  isLoading: false,

  setTokens: (tokens) => {
    writeStoredTokens(tokens);
    set({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  },

  setSession: (session) => {
    writeStoredTokens(session.tokens);
    set({
      user: session.user,
      organization: session.organization,
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
      isHydrated: true,
    });
  },

  login: async (email, password) => {
    set({ isLoading: true });
    try {
      const session = await apiFetch<AuthSession>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        skipAuth: true,
      });
      get().setSession(session);
    } finally {
      set({ isLoading: false });
    }
  },

  register: async (input) => {
    set({ isLoading: true });
    try {
      const session = await apiFetch<AuthSession>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(input),
        skipAuth: true,
      });
      get().setSession(session);
    } finally {
      set({ isLoading: false });
    }
  },

  logout: async () => {
    // STANDALONE has no session to end; the local user is always signed in.
    if (STANDALONE) return;

    const refreshToken = get().refreshToken;
    try {
      if (refreshToken) {
        await apiFetch('/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
          skipAuth: true,
        });
      }
    } catch {
      // Clear local session regardless of network failure
    } finally {
      writeStoredTokens(null);
      clearPersistedAiChats();
      set({
        user: null,
        organization: null,
        accessToken: null,
        refreshToken: null,
        isHydrated: true,
      });
    }
  },

  hydrate: async () => {
    // STANDALONE: no /auth/me request. The user is the fixed local user.
    if (STANDALONE) {
      set({
        user: LOCAL_USER,
        organization: LOCAL_ORGANIZATION,
        accessToken: STANDALONE_ACCESS_TOKEN,
        refreshToken: null,
        isHydrated: true,
      });
      return;
    }

    const { accessToken, refreshToken } = get();
    if (!accessToken && !refreshToken) {
      set({ isHydrated: true });
      return;
    }

    try {
      const data = await apiFetch<{ user: User; organization: Organization }>('/auth/me');
      set({
        user: data.user,
        organization: data.organization,
        isHydrated: true,
      });
    } catch {
      writeStoredTokens(null);
      set({
        user: null,
        organization: null,
        accessToken: null,
        refreshToken: null,
        isHydrated: true,
      });
    }
  },
}));

type AuthChangeListener = (auth: {
  accessToken: string | null;
  userName: string | null;
}) => void;

const authChangeListeners = new Set<AuthChangeListener>();

export function subscribeAuthChange(listener: AuthChangeListener): () => void {
  authChangeListeners.add(listener);
  return () => {
    authChangeListeners.delete(listener);
  };
}

function notifyAuthChange(accessToken: string | null, userName: string | null): void {
  for (const listener of authChangeListeners) {
    listener({ accessToken, userName });
  }
}

registerAuthHandlers({
  getAccessToken: () => useAuthStore.getState().accessToken,
  getRefreshToken: () => useAuthStore.getState().refreshToken,
  onTokensRefreshed: (session) => {
    useAuthStore.getState().setSession(session);
    notifyAuthChange(session.tokens.accessToken, session.user.name);
  },
  onAuthFailure: () => {
    // STANDALONE never signs out (a 401 here means the API is not in STANDALONE).
    if (STANDALONE) return;
    writeStoredTokens(null);
    clearPersistedAiChats();
    useAuthStore.setState({
      user: null,
      organization: null,
      accessToken: null,
      refreshToken: null,
      isHydrated: true,
    });
    notifyAuthChange(null, null);
  },
});

useAuthStore.subscribe((state, prevState) => {
  if (
    state.accessToken !== prevState.accessToken ||
    state.user?.name !== prevState.user?.name
  ) {
    notifyAuthChange(state.accessToken, state.user?.name ?? null);
  }
});
