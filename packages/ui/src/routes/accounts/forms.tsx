import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Field, Input } from '../../components/ui/Field';
import type { QuotaLimits } from '../../lib/types';

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
