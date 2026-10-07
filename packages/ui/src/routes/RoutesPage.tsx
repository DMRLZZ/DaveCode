import { Pencil, Plus, Route as RouteIcon } from 'lucide-react';
import { useMemo } from 'react';
import { ACCOUNT_STATUS_TONE, ProviderIcon } from '../components/domain';
import { Badge, Dot } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Callout } from '../components/ui/Callout';
import { CopyButton } from '../components/ui/CopyButton';
import { EmptyState } from '../components/ui/EmptyState';
import { PageHeader, Panel, PanelHeader } from '../components/ui/Panel';
import { SkeletonRows } from '../components/ui/Skeleton';
import { errorMessage } from '../lib/api';
import { providerMeta } from '../lib/providers';
import { useAccounts, useModels, useRoutes } from '../lib/queries';
import { Link, setParam, useLocation } from '../lib/router';
import { useSettings } from '../lib/settings';
import type { Account, RouteTarget } from '../lib/types';
import { RoutesEditorSheet } from './RoutesEditor';

/** Accounts that can serve a target, mirroring the router's candidate resolution. */
function candidates(target: RouteTarget, accounts: Account[]): Account[] {
  return accounts.filter((a) => {
    if (target.accountId) return a.id === target.accountId;
    if (a.provider !== target.provider) return false;
    const models = a.config.models;
    return !Array.isArray(models) || models.length === 0 || models.includes(target.model);
  });
}

export function RoutesPage() {
  const routes = useRoutes();
  const { params } = useLocation();
  const editing = params.get('edit') === '1';
  const accounts = useAccounts();
  const models = useModels();
  const settings = useSettings();
  const all = accounts.data ?? [];
  const base = `${settings.gatewayUrl || 'http://127.0.0.1:4040'}/v1`;
  const defaultRoute = routes.data?.defaultRoute ?? 'auto';

  const exposed = useMemo(() => {
    const list = models.data ?? [];
    return { total: list.length, routes: list.filter((m) => m.owned_by === 'davecode').length };
  }, [models.data]);

  const snippet = `curl ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $DAVECODE_TOKEN" \\
  -d '{"model": "davecode/${defaultRoute}", "messages": [{"role": "user", "content": "Hello"}]}'`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Routes"
        description={
          <>
            Exposed to clients as{' '}
            <code className="font-mono text-fg-2">davecode/&lt;route&gt;</code>. Targets are tried
            in order; the router fails over down the list before the first byte.
          </>
        }
        actions={
          <>
            {models.data && (
              <Badge mono>
                {exposed.total} models · {exposed.routes} routes on /v1/models
              </Badge>
            )}
            <Button
              variant="primary"
              icon={Pencil}
              disabled={!routes.data}
              onClick={() => setParam('edit', '1')}
            >
              Edit routes
            </Button>
          </>
        }
      />

      {routes.isError && (
        <Callout tone="err" title="Could not load routes">
          {errorMessage(routes.error)}
        </Callout>
      )}

      {routes.isPending ? (
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      ) : (routes.data?.routes.length ?? 0) === 0 ? (
        <Panel>
          <EmptyState
            icon={RouteIcon}
            title="No routes configured"
            description="Until you add one, clients can call provider/model ids directly. Routes are saved to ~/.davecode/config.json."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setParam('edit', '1')}>
                Add a route
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {routes.data?.routes.map((route) => (
            <Panel key={route.name} aria-labelledby={`route-${route.name}`}>
              <PanelHeader
                id={`route-${route.name}`}
                title={
                  <span className="inline-flex items-center gap-1.5 font-mono">
                    davecode/{route.name}
                    <CopyButton
                      value={`davecode/${route.name}`}
                      label={`Copy davecode/${route.name}`}
                    />
                  </span>
                }
                actions={
                  route.name === defaultRoute ? <Badge tone="accent">default</Badge> : undefined
                }
              />
              {route.description && (
                <p className="px-3.5 pt-3 text-[12px] text-muted">{route.description}</p>
              )}
              <ol className="flex flex-col p-3.5">
                {route.targets.map((t, i) => {
                  const cands = candidates(t, all);
                  const usable = cands.filter((a) => a.enabled && a.status !== 'disabled');
                  return (
                    <li
                      key={`${t.provider}/${t.model}/${t.accountId ?? ''}`}
                      className="relative flex gap-3 pb-3 last:pb-0"
                    >
                      {i < route.targets.length - 1 && (
                        <span
                          aria-hidden
                          className="absolute top-7 bottom-0 left-[11px] w-px bg-line-strong"
                        />
                      )}
                      <span className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-raised font-mono text-[11px] text-fg-2">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1 rounded-md border border-line bg-raised px-2.5 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <ProviderIcon provider={t.provider} size="sm" />
                          <span className="truncate font-mono text-[12px] text-fg">
                            {t.provider}/{t.model}
                          </span>
                          {usable.length === 0 && (
                            <Badge tone="err" className="ml-auto">
                              no usable account
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                          <span>
                            {t.accountId
                              ? 'pinned to'
                              : `balanced · ${providerMeta(t.provider).label}`}
                          </span>
                          {cands.length === 0 && (
                            <span className="text-faint">no matching account</span>
                          )}
                          {cands.map((a) => (
                            <Link
                              key={a.id}
                              to={`/accounts?account=${encodeURIComponent(a.id)}`}
                              className="inline-flex items-center gap-1.5 text-fg-2 hover:text-fg"
                            >
                              <Dot tone={ACCOUNT_STATUS_TONE[a.status]} />
                              {a.label}
                              <span className="sr-only">({a.status})</span>
                            </Link>
                          ))}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Panel>
          ))}
        </div>
      )}

      <RoutesEditorSheet
        open={editing && Boolean(routes.data)}
        onClose={() => setParam('edit', null)}
        routes={routes.data?.routes ?? []}
        defaultRoute={defaultRoute}
      />

      <Panel aria-labelledby="usage-title">
        <PanelHeader
          id="usage-title"
          title="Use a route"
          meta="any OpenAI-compatible client"
          actions={<CopyButton value={snippet} label="Copy snippet" />}
        />
        <pre className="overflow-x-auto p-3.5 font-mono text-[12px] leading-5 text-fg-2">
          {snippet}
        </pre>
      </Panel>
    </div>
  );
}
