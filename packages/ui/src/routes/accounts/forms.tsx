import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Field, Input, Select } from '../../components/ui/Field';
import type { QuotaLimits, SubscriptionInfo } from '../../lib/types';

export type LimitsDraft = Record<keyof QuotaLimits, string>;

export const LIMIT_FIELDS: { key: keyof QuotaLimits; label: string }[] = [
  { key: 'tpm', label: 'Tokens / min' },
  { key: 'rpm', label: 'Requests / min' },
  { key: 'tokens5h', label: 'Tokens / 5 h' },
  { key: 'requests5h', label: 'Requests / 5 h' },
  { key: 'tokensDaily', label: 'Tokens / 24 h' },
  { key: 'requestsDaily', label: 'Requests / 24 h' },
];

export function limitsToDraft(l: QuotaLimits = {}): LimitsDraft {
  const out = {} as LimitsDraft;
  for (const { key } of LIMIT_FIELDS) out[key] = l[key] !== undefined ? String(l[key]) : '';
  return out;
}

/** Parse the draft; returns the limits or a map of field errors. */
export function parseLimits(d: LimitsDraft): { limits: QuotaLimits; errors: Partial<LimitsDraft> } {
  const limits: QuotaLimits = {};
  const errors: Partial<LimitsDraft> = {};
  for (const { key } of LIMIT_FIELDS) {
    const raw = d[key].replace(/[,_\s]/g, '');
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) errors[key] = 'Whole number above 0';
    else limits[key] = n;
  }
  return { limits, errors };
}

export function LimitsFields({
  value,
  onChange,
  errors,
}: {
  value: LimitsDraft;
  onChange: (v: LimitsDraft) => void;
  errors: Partial<LimitsDraft>;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-3">
      {LIMIT_FIELDS.map(({ key, label }) => (
        <Field key={key} label={label} error={errors[key]}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="numeric"
              placeholder="unlimited"
              value={value[key]}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => onChange({ ...value, [key]: e.target.value })}
              className="tnum font-mono"
            />
          )}
        </Field>
      ))}
    </div>
  );
}

/** Write-only secret input: never prefilled, never echoed back after save. */
export function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  describedBy,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        autoCapitalize="off"
        value={value}
        placeholder={placeholder}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className="pr-9 font-mono"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide secret' : 'Show secret'}
        aria-pressed={visible}
        className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
      >
        {visible ? (
          <EyeOff aria-hidden className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Eye aria-hidden className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
    </div>
  );
}

export interface SubscriptionDraft {
  plan: string;
  amount: string;
  currency: string;
  period: 'month' | 'year';
  paidAt: string;
  renewsAt: string;
  notes: string;
}

export function subscriptionToDraft(s: SubscriptionInfo | undefined): SubscriptionDraft {
  return {
    plan: s?.plan ?? '',
    amount: s?.price ? String(s.price.amount) : '',
    currency: s?.price?.currency ?? 'USD',
    period: s?.price?.period ?? 'month',
    paidAt: s?.paidAt?.slice(0, 10) ?? '',
    renewsAt: s?.renewsAt?.slice(0, 10) ?? '',
    notes: s?.notes ?? '',
  };
}

/** Parse the draft; `subscription` is undefined when every field is empty. */
export function parseSubscription(d: SubscriptionDraft): {
  subscription: SubscriptionInfo | undefined;
  errors: Partial<Record<keyof SubscriptionDraft, string>>;
} {
  const errors: Partial<Record<keyof SubscriptionDraft, string>> = {};
  const out: SubscriptionInfo = {};
  if (d.plan.trim()) out.plan = d.plan.trim();
  if (d.notes.trim()) out.notes = d.notes.trim();
  if (d.paidAt) out.paidAt = d.paidAt;
  if (d.renewsAt) out.renewsAt = d.renewsAt;
  const amount = d.amount.replace(/[,\s]/g, '');
  if (amount) {
    const n = Number(amount);
    const currency = d.currency.trim().toUpperCase();
    if (!Number.isFinite(n) || n < 0) errors.amount = 'Number, 0 or more';
    if (!/^[A-Z]{3}$/.test(currency)) errors.currency = '3-letter code';
    if (!errors.amount && !errors.currency) out.price = { amount: n, currency, period: d.period };
  }
  return { subscription: Object.keys(out).length > 0 ? out : undefined, errors };
}

export function SubscriptionFields({
  value,
  onChange,
  errors,
}: {
  value: SubscriptionDraft;
  onChange: (v: SubscriptionDraft) => void;
  errors: Partial<Record<keyof SubscriptionDraft, string>>;
}) {
  const set = <K extends keyof SubscriptionDraft>(key: K, v: SubscriptionDraft[K]) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="flex flex-col gap-3">
      <Field label="Plan" hint="As the vendor calls it, e.g. Claude Pro or API pay-as-you-go.">
        {({ id, describedBy }) => (
          <Input
            id={id}
            value={value.plan}
            placeholder="Claude Pro"
            aria-describedby={describedBy}
            onChange={(e) => set('plan', e.target.value)}
          />
        )}
      </Field>
      <div className="grid grid-cols-[1fr_5.5rem_7rem] gap-3">
        <Field label="Price" error={errors.amount}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="decimal"
              placeholder="20"
              value={value.amount}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => set('amount', e.target.value)}
              className="tnum font-mono"
            />
          )}
        </Field>
        <Field label="Currency" error={errors.currency}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              maxLength={3}
              value={value.currency}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => set('currency', e.target.value.toUpperCase())}
              className="font-mono uppercase"
            />
          )}
        </Field>
        <Field label="Per">
          {({ id }) => (
            <Select
              id={id}
              value={value.period}
              onChange={(e) => set('period', e.target.value as SubscriptionDraft['period'])}
            >
              <option value="month">month</option>
              <option value="year">year</option>
            </Select>
          )}
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Last paid">
          {({ id }) => (
            <Input
              id={id}
              type="date"
              value={value.paidAt}
              onChange={(e) => set('paidAt', e.target.value)}
              className="font-mono"
            />
          )}
        </Field>
        <Field label="Renews on">
          {({ id }) => (
            <Input
              id={id}
              type="date"
              value={value.renewsAt}
              onChange={(e) => set('renewsAt', e.target.value)}
              className="font-mono"
            />
          )}
        </Field>
      </div>
      <Field label="Notes">
        {({ id }) => (
          <Input
            id={id}
            value={value.notes}
            placeholder="Shared with the team, prepaid credits…"
            onChange={(e) => set('notes', e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

export function parseModels(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
