import { ShieldAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ProviderIcon } from '../../components/domain';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { CommandHint } from '../../components/ui/CopyButton';
import { Field, Input } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Overlay';
import { errorMessage, isApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { PROVIDER_ORDER, providerMeta } from '../../lib/providers';
import { useAccounts, useCreateAccount, useHealth } from '../../lib/queries';
import { toast } from '../../lib/toast';
import type { AccountCreate, ProviderKind } from '../../lib/types';
import {
  isValidUrl,
  type LimitsDraft,
  LimitsFields,
  limitsToDraft,
  parseLimits,
  parseModels,
  SecretInput,
} from './forms';

interface Errors {
  label?: string;
  secret?: string;
  baseUrl?: string;
  priority?: string;
  weight?: string;
  ack?: string;
  limits?: Partial<LimitsDraft>;
}

export function AddAccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add account"
      description="Secrets are encrypted at rest with AES-256-GCM and are never shown again after saving."
      width="w-[min(560px,100vw)]"
    >
      {open && <AddAccountForm onDone={onClose} />}
    </Sheet>
  );
}

function AddAccountForm({ onDone }: { onDone: () => void }) {
  const health = useHealth();
  const accounts = useAccounts();
  const create = useCreateAccount();
  const geminiWebEnabled = health.data?.experimental.geminiWeb ?? false;
  const rotationEnabled = health.data?.experimental.multiAccountRotation ?? false;

  const [provider, setProvider] = useState<ProviderKind>('anthropic');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const [binary, setBinary] = useState('');
  const [priority, setPriority] = useState('100');
  const [weight, setWeight] = useState('1');
  const [limits, setLimits] = useState<LimitsDraft>(limitsToDraft());
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const meta = providerMeta(provider);
  const sameProvider = (accounts.data ?? []).filter((a) => a.provider === provider);
  const rotationWarning = meta.subscription && sameProvider.length > 0 && !rotationEnabled;
  const blocked = provider === 'gemini-web' && !geminiWebEnabled;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const next: Errors = {};
    if (!label.trim()) next.label = 'Give the account a name you will recognise in logs.';
    if (meta.auth === 'api-key' && !secret.trim())
      next.secret = `${meta.secretLabel ?? 'Secret'} is required.`;
    if (provider === 'openai-compatible' && !isValidUrl(baseUrl.trim())) {
      next.baseUrl = 'Enter an http(s) URL ending in the /v1 base, e.g. http://127.0.0.1:11434/v1';
    }
    const p = Number(priority);
    if (!Number.isInteger(p) || p < 0) next.priority = 'Whole number, 0 or more.';
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) next.weight = 'Number above 0.';
    if (provider === 'gemini-web' && !ack) next.ack = 'Confirm that you accept the risk.';
    const parsed = parseLimits(limits);
    if (Object.keys(parsed.errors).length) next.limits = parsed.errors;
    setErrors(next);
    if (Object.keys(next).length || blocked) return;

    const config: Record<string, unknown> = {};
    if (provider === 'openai-compatible') {
      config.baseUrl = baseUrl.trim();
      const list = parseModels(models);
      if (list.length) config.models = list;
    }
    if (meta.auth === 'cli' && binary.trim()) config.binary = binary.trim();

    const body: AccountCreate = {
      provider,
      label: label.trim(),
      priority: p,
      weight: w,
      ...(Object.keys(parsed.limits).length && { limits: parsed.limits }),
      ...(Object.keys(config).length && { config }),
      ...(secret.trim() && { secret: secret.trim() }),
    };

    try {
      const account = await create.mutateAsync(body);
      setSecret('');
      toast({
        tone: 'ok',
        title: 'Account added',
        description: `${account.label} (${account.id})`,
      });
      onDone();
    } catch (err) {
      setSecret('');
      setServerError(
        isApiError(err) && err.code === 'experimental_disabled'
          ? 'The gateway refused this provider: experimental.geminiWeb is off in config.json.'
          : errorMessage(err),
      );
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-2 text-[12px] font-medium text-fg-2">Provider</legend>
        <div className="grid grid-cols-2 gap-2">
          {PROVIDER_ORDER.map((kind) => {
            const m = providerMeta(kind);
            // Still selectable so the Terms-of-Service explanation is reachable; submit is blocked.
            const off = kind === 'gemini-web' && !geminiWebEnabled;
            const checked = provider === kind;
            return (
              <label
                key={kind}
                className={cn(
                  'relative flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors duration-150',
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                  checked
                    ? 'border-accent/60 bg-accent-soft'
                    : 'border-line hover:border-line-strong hover:bg-hover',
                  off && !checked && 'opacity-60',
                )}
              >
                <input
                  type="radio"
                  name="provider"
                  value={kind}
                  checked={checked}
                  onChange={() => {
                    setProvider(kind);
                    setErrors({});
                    setServerError(null);
                  }}
                  className="sr-only"
                />
                <ProviderIcon provider={kind} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                    {m.label}
                    {m.experimental && (
                      <span className="rounded border border-warn/30 px-1 text-2xs font-medium text-warn">
                        {off ? 'off' : 'experimental'}
                      </span>
                    )}
                  </span>
                  <span className="block font-mono text-2xs text-muted">{kind}</span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] text-muted">{meta.blurb}</p>
      </fieldset>

      {provider === 'gemini-web' && (
        <Callout tone="warn" title="Terms of Service risk">
          <p>
            This provider automates a consumer Gemini web session through Chromium. That likely
            violates Google's Terms of Service and the account can be rate-limited or suspended.
          </p>
          {!geminiWebEnabled ? (
            <p className="mt-1.5">
              It is disabled on this gateway. To opt in, set{' '}
              <code className="font-mono text-fg">"experimental": {'{ "geminiWeb": true }'}</code>{' '}
              in <code className="font-mono text-fg">~/.davecode/config.json</code> and restart.
            </p>
          ) : (
            <label className="mt-2 flex items-start gap-2 text-fg">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="mt-0.5 accent-accent"
                aria-describedby={errors.ack ? 'ack-error' : undefined}
              />
              I understand the risk and want to add this account anyway.
            </label>
          )}
          {errors.ack && (
            <p id="ack-error" role="alert" className="mt-1 text-err">
              {errors.ack}
            </p>
          )}
        </Callout>
      )}

      {rotationWarning && (
        <Callout tone="info" title="Multi-account rotation is off">
          You already have a {meta.label} account. Without{' '}
          <code className="font-mono text-fg">experimental.multiAccountRotation</code> the router
          uses only one subscription login per provider; the others act as manual fallbacks.
        </Callout>
      )}

      {!blocked && (
        <>
          <Field
            label="Label"
            required
            error={errors.label}
            hint="Shown in the dashboard, logs and events."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                value={label}
                placeholder={
                  provider === 'openai-compatible' ? 'Ollama — workstation' : `${meta.label} — work`
                }
                onChange={(e) => setLabel(e.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-required
              />
            )}
          </Field>

          {provider === 'openai-compatible' && (
            <>
              <Field
                label="Base URL"
                required
                error={errors.baseUrl}
                hint="The OpenAI-compatible root, including /v1."
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="url"
                    value={baseUrl}
                    placeholder="http://127.0.0.1:11434/v1"
                    onChange={(e) => setBaseUrl(e.target.value)}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    className="font-mono"
                  />
                )}
              </Field>
              <Field
                label="Models"
                hint="Comma-separated allow-list. Leave empty to discover via /v1/models."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    value={models}
                    placeholder="qwen3:32b, llama4:scout"
                    onChange={(e) => setModels(e.target.value)}
                    aria-describedby={describedBy}
                    className="font-mono"
                  />
                )}
              </Field>
            </>
          )}

          {meta.auth === 'cli' ? (
            <div className="flex flex-col gap-2">
              <Field label="CLI binary" hint="Optional path; defaults to the binary on your PATH.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    value={binary}
                    placeholder={provider === 'claude-cli' ? 'claude' : 'codex'}
                    onChange={(e) => setBinary(e.target.value)}
                    aria-describedby={describedBy}
                    className="font-mono"
                  />
                )}
              </Field>
              <p className="text-[12px] text-muted">
                No secret is needed here. The CLI signs in inside its own sandbox (
                {provider === 'claude-cli' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}) the first time it
                runs. To log in interactively, use the terminal:
              </p>
              <CommandHint command={`davecode add-account --provider ${provider}`} />
            </div>
          ) : meta.auth === 'browser' ? null : (
            <Field
              label={meta.secretLabel ?? 'Secret'}
              required={meta.auth === 'api-key'}
              error={errors.secret}
              hint="Write-only. Encrypted at rest; no endpoint ever returns it."
            >
              {({ id, describedBy, invalid }) => (
                <SecretInput
                  id={id}
                  value={secret}
                  onChange={setSecret}
                  placeholder={meta.secretPlaceholder}
                  describedBy={describedBy}
                  invalid={invalid}
                />
              )}
            </Field>
          )}

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

          <details className="group rounded-md border border-line">
            <summary className="flex items-center justify-between px-3 py-2 text-[12px] font-medium text-fg-2 select-none hover:text-fg">
              Quota limits
              <span className="text-2xs font-normal text-muted group-open:hidden">
                optional · unlimited by default
              </span>
            </summary>
            <div className="border-t border-line p-3">
              <LimitsFields value={limits} onChange={setLimits} errors={errors.limits ?? {}} />
            </div>
          </details>
        </>
      )}

      {serverError && (
        <Callout tone="err" title="Could not add the account">
          {serverError}
        </Callout>
      )}

      <div className="sticky -bottom-4 -mx-5 -mb-4 flex items-center justify-end gap-2 border-t border-line bg-panel px-5 py-3">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          disabled={blocked}
          icon={blocked ? ShieldAlert : undefined}
        >
          {blocked ? 'Disabled by config' : 'Add account'}
        </Button>
      </div>
    </form>
  );
}
