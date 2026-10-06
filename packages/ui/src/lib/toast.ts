import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  tone: 'ok' | 'err' | 'info';
  title: string;
  description?: string;
}

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Show a transient notification (auto-dismissed after 4 s, announced politely). */
export function toast(t: Omit<Toast, 'id'>): void {
  seq += 1;
  const id = seq;
  toasts = [...toasts.slice(-3), { ...t, id }];
  emit();
  setTimeout(() => dismissToast(id), 4000);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
    () => toasts,
  );
}
