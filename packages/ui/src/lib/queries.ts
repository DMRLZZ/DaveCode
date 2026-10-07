import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunnerAction } from './api';
import { qk, useData } from './data';
import type {
  Account,
  AccountCreate,
  AccountPatch,
  RoutesUpdate,
  RunnerStatus,
  TaskCreate,
  TaskNode,
  TaskPatch,
  TasksResponse,
} from './types';

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

/** Patches the cached task list so the graph reflects a write before its event arrives. */
function useTasksCache() {
  const { sourceKey } = useData();
  const qc = useQueryClient();
  const key = qk(sourceKey, 'tasks');
  return {
    upsert: (task: TaskNode) =>
      qc.setQueryData<TasksResponse>(key, (prev) => {
        if (!prev) return prev;
        const tasks = prev.graph.tasks.slice();
        const i = tasks.findIndex((t) => t.id === task.id);
        if (i === -1) tasks.push(task);
        else tasks[i] = task;
        return { ...prev, graph: { ...prev.graph, tasks } };
      }),
    remove: (id: string) =>
      qc.setQueryData<TasksResponse>(key, (prev) =>
        prev
          ? {
              ...prev,
              graph: { ...prev.graph, tasks: prev.graph.tasks.filter((t) => t.id !== id) },
            }
          : prev,
      ),
    invalidate: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: qk(sourceKey, 'brain') });
    },
  };
}

export function useCreateTask() {
  const { client } = useData();
  const cache = useTasksCache();
  return useMutation({
    mutationFn: (body: TaskCreate) => client.createTask(body),
    onSuccess: (task) => cache.upsert(task),
    onSettled: () => cache.invalidate(),
  });
}

export function useUpdateTask() {
  const { client } = useData();
  const cache = useTasksCache();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TaskPatch }) => client.updateTask(id, patch),
    onSuccess: (task) => cache.upsert(task),
    onSettled: () => cache.invalidate(),
  });
}

export function useDeleteTask() {
  const { client } = useData();
  const cache = useTasksCache();
  return useMutation({
    mutationFn: (id: string) => client.deleteTask(id),
    onSuccess: (_r, id) => cache.remove(id),
    onSettled: () => cache.invalidate(),
  });
}

export function useUpdateRoutes() {
  const { client, sourceKey } = useData();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RoutesUpdate) => client.updateRoutes(body),
    onSuccess: ({ defaultRoute, routes }) => {
      qc.setQueryData(qk(sourceKey, 'routes'), { defaultRoute, routes });
      // The model list exposes one `davecode/<route>` entry per route.
      qc.invalidateQueries({ queryKey: qk(sourceKey, 'models') });
    },
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

/** Start the runner on one specific task (`POST /api/runner/start { taskId }`). */
export function useRunTask() {
  const { client, sourceKey } = useData();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => client.runnerAction('start', { taskId }),
    onSuccess: (status: RunnerStatus) => qc.setQueryData(qk(sourceKey, 'runner'), status),
  });
}
