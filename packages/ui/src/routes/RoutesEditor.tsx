import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { ProviderIcon } from '../components/domain';
import { Button } from '../components/ui/Button';
import { Callout } from '../components/ui/Callout';
import { Field, Input, Select } from '../components/ui/Field';
import { Sheet } from '../components/ui/Overlay';
import { cn } from '../lib/cn';
import { PROVIDER_ORDER, providerMeta } from '../lib/providers';
import { useAccounts, useModels, useUpdateRoutes } from '../lib/queries';
import {
  isDirty,
  moveItem,
  newRoute,
  newTarget,
  type RouteDraft,
  type RoutesDraft,
  suggestRouteName,
  type TargetDraft,
  toDraft,
  toRequest,
  validateDraft,
} from '../lib/route-edit';
import { writeErrorMessage } from '../lib/task-errors';
import { toast } from '../lib/toast';
import type { Account, ProviderKind, Route } from '../lib/types';

export function RoutesEditorSheet({
  open,
  onClose,
  routes,
  defaultRoute,
}: {
  open: boolean;
  onClose: () => void;
  routes: Route[];
  defaultRoute: string;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit routes"
      description={
        <>
          Saved to the global <span className="font-mono">~/.davecode/config.json</span> and applied
          to the router immediately.
        </>
      }
      width="w-[min(680px,100vw)]"
    >
      {open && <RoutesForm routes={routes} defaultRoute={defaultRoute} onDone={onClose} />}
    </Sheet>
  );
}

function RoutesForm({
  routes,
  defaultRoute,
  onDone,
}: {
  routes: Route[];
  defaultRoute: string;
  onDone: () => void;
}) {
  const accountsQ = useAccounts();
  const modelsQ = useModels();
  const save = useUpdateRoutes();
  const accounts = accountsQ.data ?? [];
  const [draft, setDraft] = useState<RoutesDraft>(() => toDraft(routes, defaultRoute));
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const validation = useMemo(() => validateDraft(draft, accounts), [draft, accounts]);
  const dirty = isDirty(draft, routes, defaultRoute);

  const modelsFor = useMemo(() => {
    const map = new Map<ProviderKind, string[]>();
    for (const m of modelsQ.data ?? []) {
      if (m.owned_by === 'davecode') continue;
      const provider = m.owned_by as ProviderKind;
      const prefix = `${provider}/`;
      const list = map.get(provider) ?? [];
      list.push(m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id);
      map.set(provider, list);
    }
    return map;
  }, [modelsQ.data]);

  const updateRoute = (key: string, change: (r: RouteDraft) => RouteDraft) =>
    setDraft((d) => ({ ...d, routes: d.routes.map((r) => (r.key === key ? change(r) : r)) }));

  const updateTarget = (routeKey: string, targetKey: string, patch: Partial<TargetDraft>) =>
    updateRoute(routeKey, (r) => ({
      ...r,
      targets: r.targets.map((t) => (t.key === targetKey ? { ...t, ...patch } : t)),
    }));

  const addRoute = () =>
    setDraft((d) => {
      const route = newRoute(suggestRouteName(d.routes));
      return { routes: [...d.routes, route], defaultKey: d.defaultKey ?? route.key };
    });

  const removeRoute = (key: string) =>
    setDraft((d) => {
      const rest = d.routes.filter((r) => r.key !== key);
      return {
        routes: rest,
        defaultKey: d.defaultKey === key ? (rest[0]?.key ?? null) : d.defaultKey,
      };
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (!validation.valid) return;
    try {
      const res = await save.mutateAsync(toRequest(draft));
      toast({
        tone: 'ok',
        title: 'Routes saved',
        description: `${res.routes.length} route${res.routes.length === 1 ? '' : 's'}, default davecode/${res.defaultRoute}`,
      });
      if (res.shadowedByProject) {
        toast({
          tone: 'info',
          title: 'This project overrides routes',
          description:
            'The project .davecode/config.json also sets routing and wins after a restart.',
        });
      }
      onDone();
    } catch (err) {
      setServerError(writeErrorMessage(err));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {draft.routes.length === 0 && (
        <p className="rounded-md border border-dashed border-line-strong px-3 py-6 text-center text-[12px] text-muted">
          No routes. Clients can still call <span className="font-mono">provider/model</span> ids
          directly. Add a route to expose <span className="font-mono">davecode/&lt;name&gt;</span>.
        </p>
      )}

      {draft.routes.map((route) => {
        const errors = validation.byRoute[route.key];
        const isDefault = draft.defaultKey === route.key;
        const showErrors = submitted;
        return (
          <section
            key={route.key}
            aria-label={`Route ${route.name || 'unnamed'}`}
            className={cn(
              'flex flex-col gap-3 rounded-lg border bg-raised p-3',
              isDefault ? 'border-accent/50' : 'border-line',
            )}
          >
            <div className="flex items-start gap-2">
              <Field
                label="Name"
                error={showErrors ? errors?.name : null}
                className="min-w-0 flex-1"
              >
                {({ id, describedBy, invalid }) => (
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 font-mono text-[12px] text-muted">davecode/</span>
                    <Input
                      id={id}
                      value={route.name}
                      onChange={(e) =>
                        updateRoute(route.key, (r) => ({ ...r, name: e.target.value }))
                      }
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      spellCheck={false}
                      autoCapitalize="off"
                      className="font-mono"
                    />
                  </div>
                )}
              </Field>
              <label className="mt-6 flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-fg-2">
                <input
                  type="radio"
                  name="default-route"
                  checked={isDefault}
                  onChange={() => setDraft((d) => ({ ...d, defaultKey: route.key }))}
                  className="size-3.5 accent-accent"
                />
                Default
              </label>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={Trash2}
                aria-label={`Remove route ${route.name || 'unnamed'}`}
                onClick={() => removeRoute(route.key)}
                className="mt-6 text-err hover:bg-err-soft hover:text-err"
              />
            </div>

            <Field label="Description">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  value={route.description}
                  onChange={(e) =>
                    updateRoute(route.key, (r) => ({ ...r, description: e.target.value }))
                  }
                  aria-describedby={describedBy}
                  placeholder="When to use this route"
                />
              )}
            </Field>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[12px] font-medium text-fg-2">
                Targets{' '}
                <span className="font-normal text-muted">tried in order, then fail over</span>
              </legend>
              {showErrors && errors?.targets && (
                <p role="alert" className="text-[12px] text-err">
                  {errors.targets}
                </p>
              )}
              <ol className="flex flex-col gap-2">
                {route.targets.map((target, i) => (
                  <TargetRow
                    key={target.key}
                    index={i}
                    count={route.targets.length}
                    target={target}
                    accounts={accounts}
                    models={modelsFor.get(target.provider) ?? []}
                    error={showErrors ? errors?.target[target.key] : undefined}
                    onChange={(patch) => updateTarget(route.key, target.key, patch)}
                    onMove={(to) =>
                      updateRoute(route.key, (r) => ({ ...r, targets: moveItem(r.targets, i, to) }))
                    }
                    onRemove={() =>
                      updateRoute(route.key, (r) => ({
                        ...r,
                        targets: r.targets.filter((t) => t.key !== target.key),
                      }))
                    }
                  />
                ))}
              </ol>
              <Button
                size="sm"
                variant="secondary"
                icon={Plus}
                className="self-start"
                onClick={() =>
                  updateRoute(route.key, (r) => ({
                    ...r,
                    targets: [...r.targets, newTarget(r.targets.at(-1)?.provider)],
                  }))
                }
              >
                Add target
              </Button>
            </fieldset>
          </section>
        );
      })}

      {submitted && validation.defaultRoute && (
        <p role="alert" className="text-[12px] text-err">
          {validation.defaultRoute}
        </p>
      )}

      <Button variant="secondary" icon={Plus} className="self-start" onClick={addRoute}>
        Add route
      </Button>

      {serverError && (
        <Callout tone="err" title="Could not save the routes">
          {serverError}
        </Callout>
      )}

      <div className="sticky -bottom-4 -mx-5 -mb-4 flex items-center justify-end gap-2 border-t border-line bg-panel px-5 py-3">
        {!dirty && <span className="mr-auto text-[12px] text-muted">No changes</span>}
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
          Save routes
        </Button>
      </div>
    </form>
  );
}

function TargetRow({
  index,
  count,
  target,
  accounts,
  models,
  error,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  target: TargetDraft;
  accounts: Account[];
  models: string[];
  error: { model?: string; accountId?: string } | undefined;
  onChange: (patch: Partial<TargetDraft>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const listId = `models-${target.key}`;
  const pinnable = accounts.filter((a) => a.provider === target.provider);
  const gone = target.accountId && !accounts.some((a) => a.id === target.accountId);
  return (
    <li className="flex items-start gap-2 rounded-md border border-line bg-panel p-2">
      <span className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-raised font-mono text-[11px] text-fg-2">
        {index + 1}
      </span>
      <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Provider">
          {({ id }) => (
            <div className="flex items-center gap-2">
              <ProviderIcon provider={target.provider} size="sm" />
              <Select
                id={id}
                value={target.provider}
                onChange={(e) => {
                  const provider = e.target.value as ProviderKind;
                  // A pinned account only makes sense for its own provider.
                  const keep =
                    accounts.find((a) => a.id === target.accountId)?.provider === provider;
                  onChange({ provider, ...(keep ? {} : { accountId: '' }) });
                }}
              >
                {PROVIDER_ORDER.map((kind) => (
                  <option key={kind} value={kind}>
                    {providerMeta(kind).label}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </Field>
        <Field label="Model" error={error?.model}>
          {({ id, describedBy, invalid }) => (
            <>
              <Input
                id={id}
                list={listId}
                value={target.model}
                onChange={(e) => onChange({ model: e.target.value })}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                spellCheck={false}
                autoCapitalize="off"
                placeholder="claude-sonnet-5-5"
                className="font-mono"
              />
              <datalist id={listId}>
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Account" error={error?.accountId} className="sm:col-span-2">
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              value={target.accountId}
              onChange={(e) => onChange({ accountId: e.target.value })}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            >
              <option value="">Balanced across matching accounts</option>
              {gone && <option value={target.accountId}>{target.accountId} (missing)</option>}
              {pinnable.map((a) => (
                <option key={a.id} value={a.id}>
                  Pinned to {a.label} ({a.id})
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="mt-1 flex shrink-0 flex-col gap-0.5">
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={ArrowUp}
          aria-label={`Move target ${index + 1} up`}
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={ArrowDown}
          aria-label={`Move target ${index + 1} down`}
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={X}
          aria-label={`Remove target ${index + 1}`}
          onClick={onRemove}
        />
      </div>
    </li>
  );
}
