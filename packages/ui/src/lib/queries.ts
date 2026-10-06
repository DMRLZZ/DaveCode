import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunnerAction } from './api';
import { qk, useData } from './data';
import type { Account, AccountCreate, AccountPatch, RunnerStatus } from './types';

/** TanStack Query hooks over the active DaveClient. Events keep most of these fresh. */

export function useHealth() {
  const { client, sourceKey } = useData();
  return useQuery({
    queryKey: qk(sourceKey, 'health'),
    queryFn: () => client.health(),
    refetchInterval: 30_000,
  });
}

export function useAccounts() {
  const { client, sourceKey } = useData();
  return useQuery({
    queryKey: qk(sourceKey, 'accounts'),
    queryFn: () => client.listAccounts(),
    refetchInterval: 60_000,
  });
}

export function useUsage() {
  const { client, sourceKey } = useData();
  return useQuery({
    queryKey: qk(sourceKey, 'usage'),
    queryFn: () => client.usage(),
    refetchInterval: 30_000,
  });
}

export function useTimeseries(minutes = 60, bucketSec = 60) {
  const { client, sourceKey } = useData();
  return useQuery({
    queryKey: qk(sourceKey, 'timeseries', minutes, bucketSec),
    queryFn: () => client.timeseries(minutes, bucketSec),
    refetchInterval: 60_000,
  });
}

export function useRoutes() {
  const { client, sourceKey } = useData();
  return useQuery({ queryKey: qk(sourceKey, 'routes'), queryFn: () => client.routes() });
}

export function useModels() {
  const { client, sourceKey } = useData();
  return useQuery({ queryKey: qk(sourceKey, 'models'), queryFn: () => client.models() });
}

export function useTasks() {
  const { client, sourceKey } = useData();
  return useQuery({
    queryKey: qk(sourceKey, 'tasks'),
    queryFn: () => client.tasks(),
    refetchInterval: 60_000,
  });
}

export function useBrain() {
  const { client, sourceKey } = useData();
  return useQuery({
    queryKey: qk(sourceKey, 'brain'),
    queryFn: () => client.brain(),
    refetchInterval: 60_000,
  });
}

export function useRunner() {
  const { client, sourceKey } = useData();
  return useQuery({
    queryKey: qk(sourceKey, 'runner'),
    queryFn: () => client.runner(),
    refetchInterval: 15_000,
    retry: (count, err) => (err as { status?: number }).status !== 501 && count < 2,
  });
}

function useAccountsCache() {
  const { sourceKey } = useData();
  const qc = useQueryClient();
  const key = qk(sourceKey, 'accounts');
  return {
    upsert: (account: Account) =>
      qc.setQueryData<Account[]>(key, (prev) => {
        if (!prev) return [account];
        const i = prev.findIndex((a) => a.id === account.id);
        if (i === -1) return [...prev, account];
        const next = prev.slice();
        next[i] = account;
        return next;
      }),
    remove: (id: string) =>
      qc.setQueryData<Account[]>(key, (prev) => prev?.filter((a) => a.id !== id)),
    invalidate: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: qk(sourceKey, 'usage') });
    },
  };
}

export function useCreateAccount() {
  const { client } = useData();
  const cache = useAccountsCache();
  return useMutation({
    mutationFn: (body: AccountCreate) => client.createAccount(body),
    onSuccess: (account) => cache.upsert(account),
    onSettled: () => cache.invalidate(),
  });
}

export function useUpdateAccount() {
  const { client, sourceKey } = useData();
  const qc = useQueryClient();
  const cache = useAccountsCache();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AccountPatch }) =>
      client.updateAccount(id, patch),
    // Optimistic toggle so the switch responds instantly; rolled back on error.
    onMutate: async ({ id, patch }) => {
      const key = qk(sourceKey, 'accounts');
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Account[]>(key);
      if (prev && patch.enabled !== undefined) {
        qc.setQueryData<Account[]>(
          key,
          prev.map((a) =>
            a.id === id
              ? {
                  ...a,
                  enabled: patch.enabled as boolean,
                  status: patch.enabled ? 'active' : 'disabled',
                }
              : a,
          ),
        );
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk(sourceKey, 'accounts'), ctx.prev);
    },
    onSuccess: (account) => cache.upsert(account),
  });
}

export function useDeleteAccount() {
  const { client } = useData();
  const cache = useAccountsCache();
  return useMutation({
    mutationFn: (id: string) => client.deleteAccount(id),
    onSuccess: (_r, id) => cache.remove(id),
    onSettled: () => cache.invalidate(),
  });
}

export function useRunnerAction() {
  const { client, sourceKey } = useData();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: RunnerAction) => client.runnerAction(action),
    onSuccess: (status: RunnerStatus) => qc.setQueryData(qk(sourceKey, 'runner'), status),
  });
}
