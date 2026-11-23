import * as React from 'react';
import { create } from 'zustand';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastVariant = 'default' | 'success' | 'error';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, 4500);
  },
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastFn {
  (input: ToastInput): void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const pushToast = (input: ToastInput): void => {
  useToastStore.getState().push({
    title: input.title,
    description: input.description,
    variant: input.variant ?? 'default',
  });
};

export const toast: ToastFn = Object.assign(pushToast, {
  success: (title: string, description?: string) =>
    pushToast({ title, description, variant: 'success' }),
  error: (title: string, description?: string) =>
    pushToast({ title, description, variant: 'error' }),
  info: (title: string, description?: string) =>
    pushToast({ title, description, variant: 'default' }),
});

export function Toaster() {
  const { toasts, dismiss } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((item) => {
        const Icon =
          item.variant === 'success'
            ? CheckCircle2
            : item.variant === 'error'
              ? AlertCircle
              : Info;

        return (
          <div
            key={item.id}
            className={cn(
              'flex items-start gap-3 rounded-lg border bg-popover p-3.5 text-popover-foreground shadow-xl',
              item.variant === 'error'
                ? 'border-red-500/40'
                : item.variant === 'success'
                  ? 'border-emerald-500/40'
                  : 'border-border'
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                item.variant === 'error'
                  ? 'text-red-400'
                  : item.variant === 'success'
                    ? 'text-emerald-400'
                    : 'text-primary'
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{item.title}</p>
              {item.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
              className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
