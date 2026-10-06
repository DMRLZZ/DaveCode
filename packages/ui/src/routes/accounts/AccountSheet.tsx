import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { QuotaLegend, QuotaMeter } from '../../components/charts/QuotaMeter';
import { AccountStatusBadge, ProviderIcon } from '../../components/domain';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { Field, Input } from '../../components/ui/Field';
import { Dialog, Sheet } from '../../components/ui/Overlay';
import { errorMessage } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { providerMeta } from '../../lib/providers';
import { useDeleteAccount, useUpdateAccount } from '../../lib/queries';
import { toast } from '../../lib/toast';
import type { Account, AccountPatch, AccountUsage } from '../../lib/types';
import {
  isValidUrl,
  type LimitsDraft,
  LimitsFields,
  limitsToDraft,
  parseLimits,
  parseModels,
  SecretInput,
} from './forms';

export function AccountSheet({
  account,
  usage,
  onClose,
}: {
  account: Account | undefined;
  usage: AccountUsage | undefined;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={Boolean(account)}
      onClose={onClose}
      title={account?.label ?? 'Account'}
      description={account && <span className="font-mono">{account.id}</span>}
      width="w-[min(560px,100vw)]"
    >
      {account && (
        <AccountEditor key={account.id} account={account} usage={usage} onDone={onClose} />
      )}
    </Sheet>
  );
}

function AccountEditor({
  account,
  usage,
  onDone,
}: {
  account: Account;
  usage: AccountUsage | undefined;
  onDone: () => void;
}) {
  const update = useUpdateAccount();
  const remove = useDeleteAccount();
  const meta = providerMeta(account.provider);
  const cfgModels = Array.isArray(account.config.models)
    ? (account.config.models as string[]).join(', ')
    : '';

  const [label, setLabel] = useState(account.label);
  const [priority, setPriority] = useState(String(account.priority));
  const [weight, setWeight] = useState(String(account.weight));
  const [limits, setLimits] = useState<LimitsDraft>(limitsToDraft(account.limits));
  const [baseUrl, setBaseUrl] = useState(
    typeof account.config.baseUrl === 'string' ? account.config.baseUrl : '',
  );
  const [models, setModels] = useState(cfgModels);
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [limitErrors, setLimitErrors] = useState<Partial<LimitsDraft>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const next: Record<string, string | undefined> = {};
    if (!label.trim()) next.label = 'Label cannot be empty.';
    const p = Number(priority);
    if (!Number.isInteger(p) || p < 0) next.priority = 'Whole number, 0 or more.';
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) next.weight = 'Number above 0.';
    if (account.provider === 'openai-compatible' && !isValidUrl(baseUrl.trim()))
      next.baseUrl = 'Enter an http(s) URL.';
    const parsed = parseLimits(limits);
    setErrors(next);
    setLimitErrors(parsed.errors);
    if (Object.values(next).some(Boolean) || Object.keys(parsed.errors).length) return;

    const patch: AccountPatch = {};
    if (label.trim() !== account.label) patch.label = label.trim();
    if (p !== account.priority) patch.priority = p;
    if (w !== account.weight) patch.weight = w;
    if (JSON.stringify(parsed.limits) !== JSON.stringify(account.limits))
      patch.limits = parsed.limits;
    if (account.provider === 'openai-compatible') {
      const list = parseModels(models);
      const config = {
        ...account.config,
        baseUrl: baseUrl.trim(),
        models: list.length ? list : undefined,
      };
      if (JSON.stringify(config) !== JSON.stringify(account.config)) patch.config = config;
    }
    if (secret.trim()) patch.secret = secret.trim();
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    try {
      await update.mutateAsync({ id: account.id, patch });
      setSecret('');
      toast({ tone: 'ok', title: 'Account updated', description: account.label });
      onDone();
    } catch (err) {
      setSecret('');
      setServerError(errorMessage(err));
    }
  };

  const doDelete = async () => {
    try {
      await remove.mutateAsync(account.id);
      toast({ tone: 'ok', title: 'Account removed', description: account.label });
      setConfirmDelete(false);
      onDone();
    } catch (err) {
      setConfirmDelete(false);
      setServerError(errorMessage(err));
    }
  };

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-5">
      <section
        aria-label="Summary"
        className="flex flex-col gap-3 rounded-md border border-line bg-raised p-3"
      >
        <div className="flex items-center gap-2.5">
          <ProviderIcon provider={account.provider} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-fg">{meta.label}</p>
            <p className="font-mono text-2xs text-muted">
              {account.provider} · updated {formatRelative(Date.parse(account.updatedAt))}
            </p>
          </div>
          <AccountStatusBadge account={account} />
        </div>
        {account.lastError && account.status !== 'active' && (
          <p className="rounded border border-line bg-panel px-2 py-1.5 font-mono text-2xs text-fg-2">
            {account.lastError}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <QuotaMeter label="1m" usage={usage?.windows['1m']} />
          <QuotaMeter label="5h" usage={usage?.windows['5h']} />
          <QuotaMeter label="24h" usage={usage?.windows['24h']} />
          <QuotaLegend className="pl-9" />
        </div>
      </section>

      <Field label="Label" required error={errors.label}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Priority" error={errors.priority} hint="Lower is tried first.">
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="numeric"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className="tnum font-mono"
            />
          )}
        </Field>
        <Field label="Weight" error={errors.weight} hint="Share among equal priorities.">
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className="tnum font-mono"
            />
          )}
        </Field>
      </div>

      {account.provider === 'openai-compatible' && (
        <>
          <Field label="Base URL" required error={errors.baseUrl}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                className="font-mono"
              />
            )}
          </Field>
          <Field label="Models" hint="Comma-separated allow-list.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={models}
                onChange={(e) => setModels(e.target.value)}
                aria-describedby={describedBy}
                className="font-mono"
              />
            )}
          </Field>
        </>
      )}

      {(meta.auth === 'api-key' || meta.auth === 'optional-key') && (
        <Field
          label={`Replace ${(meta.secretLabel ?? 'secret').replace(' (optional)', '')}`}
          hint={
            account.hasSecret === false
              ? 'No secret stored yet. Write-only: it is encrypted at rest and never displayed.'
              : 'A secret is stored. Write-only: leave empty to keep it; it is never displayed.'
          }
        >
          {({ id, describedBy }) => (
            <SecretInput
              id={id}
              value={secret}
              onChange={setSecret}
              placeholder="••••••••••••"
              describedBy={describedBy}
            />
          )}
        </Field>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[12px] font-medium text-fg-2">Quota limits</legend>
        <LimitsFields value={limits} onChange={setLimits} errors={limitErrors} />
      </fieldset>

      {Object.keys(account.config).length > 0 && account.provider !== 'openai-compatible' && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] font-medium text-fg-2">Provider config</p>
          <pre className="overflow-x-auto rounded-md border border-line bg-raised p-2.5 font-mono text-2xs leading-5 text-fg-2">
            {JSON.stringify(account.config, null, 2)}
          </pre>
        </div>
      )}

      {serverError && (
        <Callout tone="err" title="Request failed">
          {serverError}
        </Callout>
      )}

      <div className="sticky -bottom-4 -mx-5 -mb-4 flex items-center gap-2 border-t border-line bg-panel px-5 py-3">
        <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={update.isPending}>
            Save changes
          </Button>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${account.label}?`}
        description="The account and its encrypted secret are removed from the gateway. Requests already served stay in the usage history."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep account
            </Button>
            <Button variant="danger" icon={Trash2} loading={remove.isPending} onClick={doDelete}>
              Delete account
            </Button>
          </>
        }
      >
        <p className="font-mono text-[12px] text-muted">{account.id}</p>
      </Dialog>
    </form>
  );
}
