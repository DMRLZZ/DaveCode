import type {
  Account,
  AccountUsage,
  ChatCompletionChunk,
  ChatRequest,
  ModelInfo,
  Route,
  RunnerStatus,
  TaskGraph,
} from '@davecode/core';
import type { GatewayClient, HealthResponse, StreamMeta } from '../client';

/** What the TUI needs from a gateway. Backed by HTTP in production and by fakes in tests. */
export interface ChatBackend {
  /** Base URL, e.g. `http://127.0.0.1:4040`. */
  url: string;
  /** The gateway was started inside this process (no `davecode start` running). */
  inProcess: boolean;
  health(): Promise<HealthResponse | undefined>;
  stream(
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<{ meta: StreamMeta; chunks: AsyncIterable<ChatCompletionChunk> }>;
  models(): Promise<ModelInfo[]>;
  routes(): Promise<{ defaultRoute: string; routes: Route[] }>;
  accounts(): Promise<Account[]>;
  usage(): Promise<AccountUsage[]>;
  tasks(): Promise<{ project: { root: string; name: string } | null; graph: TaskGraph }>;
  runner(): Promise<RunnerStatus>;
}

export function httpBackend(client: GatewayClient, inProcess: boolean): ChatBackend {
  return {
    url: client.baseUrl,
    inProcess,
    health: () => client.health(1500).catch(() => undefined),
    stream: (request, signal) => client.chatStream(request, signal),
    models: async () => (await client.get<{ data: ModelInfo[] }>('/v1/models')).data,
    routes: () => client.get('/api/routes'),
    accounts: async () => (await client.get<{ accounts: Account[] }>('/api/accounts')).accounts,
    usage: async () => (await client.get<{ usage: AccountUsage[] }>('/api/usage')).usage,
    tasks: () => client.get('/api/tasks'),
    runner: async () => (await client.get<{ status: RunnerStatus }>('/api/runner')).status,
  };
}
