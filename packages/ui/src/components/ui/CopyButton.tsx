import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';

export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be blocked on insecure origins; the value stays selectable.
    }
  };

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded text-muted transition-colors duration-150 hover:bg-hover hover:text-fg',
        copied && 'text-ok hover:text-ok',
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

/** A one-line shell command with a copy button, used in empty states and hints. */
export function CommandHint({ command, className }: { command: string; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-md border border-line bg-raised py-1 pr-1 pl-2.5 font-mono text-[12px] text-fg-2',
        className,
      )}
    >
      <span aria-hidden className="text-faint select-none">
        $
      </span>
      <code className="min-w-0 flex-1 truncate">{command}</code>
      <CopyButton value={command} label="Copy command" />
    </div>
  );
}
