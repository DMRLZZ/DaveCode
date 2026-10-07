import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { createHttpClient, type DaveClient, isApiError } from './api';
import type { StreamStatus } from './events';
import { type LiveState, LiveStore } from './live';
import { getMockClient } from './mock';
import { type DataMode, mockForced, useSettings } from './settings';
import type { Account, AccountUsage, DaveEvent, RunnerStatus, TasksResponse } from './types';

/**
 * Chooses the data source (live gateway or in-browser mock), owns the event stream and the
 * live store, and patches the TanStack Query cache from events so lists stay current without
 * polling.
 */

export type SourceReason = 'forced' | 'setting' | 'unreachable' | null;

export interface Connection {
  mode: 'live' | 'mock' | 'probing';
  /** Why mock data is shown, if it is. */
  reason: SourceReason;
  stream: StreamStatus;
  /** Last probe error when falling back. */
  probeError?: string;
  /** Gateway answered 401: the token is missing or wrong. */
  unauthorized: boolean;
}

interface DataContextValue {
  client: DaveClient;
  /** Changes whenever the data source changes; part of every query key. */
  sourceKey: string;
  live: LiveStore;
  connection: Connection;
  retry: () => void;
}

const DataContext = createContext<DataContextValue | null>(null);

const PROBE_INTERVAL_MS = 15_000;

function initialMode(dataMode: DataMode): { mode: Connection['mode']; reason: SourceReason } {
  if (mockForced()) return { mode: 'mock', reason: 'forced' };
  if (dataMode === 'mock') return { mode: 'mock', reason: 'setting' };
  if (dataMode === 'live') return { mode: 'live', reason: null };
  return { mode: 'probing', reason: null };
}

export function DataProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const [source, setSource] = useState(() => initialMode(settings.dataMode));
  const [probeError, setProbeError] = useState<string>();
  const [probeNonce, setProbeNonce] = useState(0);
  const [stream, setStream] = useState<StreamStatus>({ state: 'connecting', attempt: 0 });
  const [unauthorized, setUnauthorized] = useState(false);

  // Re-evaluate the source when the user changes the data-mode setting.
  useEffect(() => {
    setSource(initialMode(settings.dataMode));
  }, [settings.dataMode]);

  const http = useMemo(
    () => createHttpClient({ baseUrl: settings.gatewayUrl, token: settings.token }),
    [settings.gatewayUrl, settings.token],
  );

  // Auto mode: probe /api/health; fall back to mock when unreachable and keep probing so the
  // dashboard switches to live data as soon as `davecode start` is running.
  // biome-ignore lint/correctness/useExhaustiveDependencies: probeNonce triggers a manual retry
  useEffect(() => {
    if (mockForced() || settings.dataMode !== 'auto') return;
    let cancelled = false;
    let timer: number | undefined;
    const probe = async () => {
      try {
        await http.health();
        if (cancelled) return;
        setUnauthorized(false);
        setProbeError(undefined);
        setSource({ mode: 'live', reason: null });
      } catch (e) {
        if (cancelled) return;
        if (isApiError(e) && e.reachable) {
          setUnauthorized(e.status === 401);
          setSource({ mode: 'live', reason: null });
          return;
        }
        setProbeError(e instanceof Error ? e.message : String(e));
        setSource({ mode: 'mock', reason: 'unreachable' });
        timer = window.setTimeout(probe, PROBE_INTERVAL_MS);
      }
    };
    probe();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [http, settings.dataMode, probeNonce]);

  const client: DaveClient = source.mode === 'mock' ? getMockClient() : http;
  const sourceKey =
    source.mode === 'mock'
      ? 'mock'
      : `live:${settings.gatewayUrl}:${settings.token ? 'auth' : 'anon'}`;

  // One live store per data source.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new store per source key
  const live = useMemo(() => new LiveStore(), [sourceKey]);

  // Subscribe to the event stream (skipped while probing).
  useEffect(() => {
    if (source.mode === 'probing') return;
    setStream({ state: source.mode === 'mock' ? 'mock' : 'connecting', attempt: 0 });
    const unsubscribe = client.subscribe({
      onEvent: (event) => {
        if (live.ingest(event)) patchQueryCache(queryClient, sourceKey, event);
      },
      onStatus: (status) => setStream(status),
    });
    // Seed request chains and the console from the polling endpoints.
    client
      .requests(200)
      .then((records) => live.seedRecords(records))
      .catch(() => {});
    client
      .logs(500)
      .then((events) => {
        for (const e of events) live.ingest(e);
      })
      .catch(() => {});
    return () => {
      unsubscribe();
      live.dispose();
    };
  }, [client, live, queryClient, sourceKey, source.mode]);

  const value = useMemo<DataContextValue>(
    () => ({
      client,
      sourceKey,
      live,
      connection: {
        mode: source.mode,
        reason: source.reason,
        stream,
        probeError,
        unauthorized,
      },
      retry: () => {
        setProbeNonce((n) => n + 1);
        queryClient.invalidateQueries();
      },
    }),
    [client, sourceKey, live, source, stream, probeError, unauthorized, queryClient],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside <DataProvider>');
  return ctx;
}

export function useLive(): LiveState {
  const { live } = useData();
  return useSyncExternalStore(live.subscribe, live.getState, live.getState);
}

/** Query key helper: every key is scoped to the active data source. */
export function qk(sourceKey: string, ...parts: (string | number)[]): (string | number)[] {
  return ['dc', sourceKey, ...parts];
}

function patchQueryCache(qc: QueryClient, sourceKey: string, e: DaveEvent): void {
  switch (e.type) {
    case 'account.updated':
      qc.setQueryData<Account[]>(qk(sourceKey, 'accounts'), (prev) => {
        if (!prev) return prev;
        const i = prev.findIndex((a) => a.id === e.account.id);
        if (i === -1) return [...prev, e.account];
        const next = prev.slice();
        next[i] = e.account;
        return next;
      });
      break;
    case 'account.removed':
      qc.setQueryData<Account[]>(qk(sourceKey, 'accounts'), (prev) =>
        prev?.filter((a) => a.id !== e.accountId),
      );
      qc.setQueryData<AccountUsage[]>(qk(sourceKey, 'usage'), (prev) =>
        prev?.filter((u) => u.accountId !== e.accountId),
      );
      break;
    case 'quota.updated':
      qc.setQueryData<AccountUsage[]>(qk(sourceKey, 'usage'), (prev) => {
        if (!prev) return prev;
        const i = prev.findIndex((u) => u.accountId === e.usage.accountId);
        if (i === -1) return [...prev, e.usage];
        const next = prev.slice();
        next[i] = e.usage;
        return next;
      });
      break;
    case 'task.updated':
      qc.setQueryData<TasksResponse>(qk(sourceKey, 'tasks'), (prev) => {
        if (!prev) return prev;
        const tasks = prev.graph.tasks.slice();
        const i = tasks.findIndex((t) => t.id === e.task.id);
        if (i === -1) tasks.push(e.task);
        else tasks[i] = e.task;
        return { ...prev, graph: { ...prev.graph, tasks } };
      });
      break;
    case 'task.removed':
      qc.setQueryData<TasksResponse>(qk(sourceKey, 'tasks'), (prev) =>
        prev
          ? {
              ...prev,
              graph: { ...prev.graph, tasks: prev.graph.tasks.filter((t) => t.id !== e.taskId) },
            }
          : prev,
      );
      break;
    case 'runner.status':
      qc.setQueryData<RunnerStatus>(qk(sourceKey, 'runner'), e.status);
      break;
    default:
      break;
  }
}
