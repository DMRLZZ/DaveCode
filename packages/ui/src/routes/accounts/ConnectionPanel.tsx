import { LogIn, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { CommandHint } from '../../components/ui/CopyButton';
import { errorMessage } from '../../lib/api';
import { useConnect, useConnection } from '../../lib/queries';
import { toast } from '../../lib/toast';
import type { Account, ConnectionStatus, ConnectResult } from '../../lib/types';

/** Stop polling for a login after this long; the user can press Connect again. */
const WAIT_MS = 5 * 60_000;

const STATUS: Record<ConnectionStatus, { tone: Tone; label: string }> = {
  connected: { tone: 'ok', label: 'Connected' },
  not_connected: { tone: 'warn', label: 'Not connected' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const { tone, label } = STATUS[status];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

/**
 * "Connect subscription": shows whether the account's credentials are in place and, for
 * CLI-login accounts, starts the vendor's official sign-in through the gateway.
 */
export function ConnectionPanel({ account }: { account: Account }) {
  const [pending, setPending] = useState<ConnectResult | null>(null);
  const connection = useConnection(account.id, pending !== null);
  const connect = useConnect();
  const current = connection.data;
  const connected = current?.status === 'connected';

  useEffect(() => {
    if (!pending) return;
    if (connected) {
      setPending(null);
      toast({ tone: 'ok', title: 'Subscription connected', description: account.label });
      return;
    }
    const t = window.setTimeout(() => setPending(null), WAIT_MS);
    return () => window.clearTimeout(t);
  }, [pending, connected, account.label]);

  const start = async () => {
    try {
      setPending(await connect.mutateAsync(account.id));
    } catch (err) {
      toast({ tone: 'err', title: 'Could not start the sign-in', description: errorMessage(err) });
    }
  };

  return (
    <section
      aria-label="Connection"
      className="flex flex-col gap-2.5 rounded-md border border-line bg-raised p-3"
    >
      <div className="flex items-center gap-2">
        <p className="text-[12px] font-medium text-fg-2">Connection</p>
        {current ? (
          <ConnectionBadge status={current.status} />
        ) : connection.isError ? (
          <Badge tone="err">Check failed</Badge>
        ) : (
          <Badge>Checking…</Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          iconOnly
          aria-label="Check again"
          className="ml-auto"
          loading={connection.isFetching && !pending}
          onClick={() => connection.refetch()}
        />
      </div>

      {current?.detail && <p className="text-2xs leading-5 text-muted">{current.detail}</p>}
      {connection.isError && (
        <p className="text-2xs leading-5 text-err">{errorMessage(connection.error)}</p>
      )}

      {current?.method === 'cli-login' && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={connected ? 'secondary' : 'primary'}
              size="sm"
              icon={LogIn}
              loading={connect.isPending}
              onClick={start}
            >
              {connected ? 'Sign in again' : 'Connect subscription'}
            </Button>
            <span className="text-2xs text-muted">
              Opens the vendor’s official sign-in. DaveCode never sees your password.
            </span>
          </div>
          {pending && (
            <Callout
              tone="info"
              title={
                pending.launched
                  ? 'Waiting for the sign-in…'
                  : 'Run the sign-in on the gateway machine'
              }
            >
              <p>{pending.message}</p>
              {!pending.launched && <CommandHint command={pending.command} className="mt-2" />}
            </Callout>
          )}
          {!pending && !connected && current.loginCommand && (
            <CommandHint command={current.loginCommand} />
          )}
        </>
      )}
    </section>
  );
}
