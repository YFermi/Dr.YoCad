import { create } from 'zustand';

export const AI_CHAT_STORAGE_PREFIX = 'cadline.ai.chat.v1:';
export const AI_PRIVACY_TOAST_KEY = 'cadline.ai.privacyToastShown.v1';

export function clearPersistedAiChats(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(AI_CHAT_STORAGE_PREFIX)) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage errors in restricted browsing contexts
  }
}

export interface PendingAiPrompt {
  fileId: string;
  text: string;
  seq: number;
}

interface AiUiState {
  requestedTabSeq: number;
  pendingPrompt: PendingAiPrompt | null;
  askAboutAnnotation: (fileId: string, promptText: string) => void;
  consumePendingPrompt: () => void;
}

export const useAiStore = create<AiUiState>((set) => ({
  requestedTabSeq: 0,
  pendingPrompt: null,

  askAboutAnnotation: (fileId, promptText) =>
    set((state) => ({
      requestedTabSeq: state.requestedTabSeq + 1,
      pendingPrompt: {
        fileId,
        text: promptText,
        seq: (state.pendingPrompt?.seq ?? 0) + 1,
      },
    })),

  consumePendingPrompt: () => set({ pendingPrompt: null }),
}));
