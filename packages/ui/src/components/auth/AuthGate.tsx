import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, Check, LogOut } from 'lucide-react';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { z } from 'zod';
import { navigate, parseLocation } from '../../lib/router';
import { updateSettings, useSettings } from '../../lib/settings';
import type { LoginStatus } from '../../lib/types';
import { BrandMark } from '../shell/Sidebar';
import { Button } from '../ui/Button';

const AuthContext = createContext<{ user: LoginStatus['user']; logout: () => void; busy: boolean }>(
  { user: null, logout: () => {}, busy: false },
);

const loginStatusSchema = z.object({
  required: z.boolean(),
  providers: z.array(z.enum(['google', 'github'])),
  user: z
    .object({ id: z.string(), provider: z.enum(['google', 'github']), name: z.string() })
    .nullable(),
});

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5">
      <path
        fill="#4285f4"
        d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.3Z"
      />
      <path
        fill="#34a853"
        d="M12 22c2.7 0 5-.9 6.6-2.5L15.4 17c-.9.6-2 1-3.4 1-2.6 0-4.9-1.8-5.7-4.2H3v2.6A10 10 0 0 0 12 22Z"
      />
      <path fill="#fbbc05" d="M6.3 13.8a6 6 0 0 1 0-3.6V7.6H3a10 10 0 0 0 0 8.8l3.3-2.6Z" />
      <path
        fill="#ea4335"
        d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.6l3.3 2.6A6 6 0 0 1 12 6Z"
      />
    </svg>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const base = settings.gatewayUrl.replace(/\/+$/, '');
  const qc = useQueryClient();
  const [local, setLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const session = useQuery({
    queryKey: ['auth', base],
    queryFn: async (): Promise<LoginStatus> => {
      const response = await fetch(`${base}/api/auth/session`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Could not reach the sign-in service.');
      const parsed = loginStatusSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('This gateway does not support sign-in yet.');
      // The gateway is authoritative for session validity; no credential is stored in the UI.
      return parsed.data;
    },
    retry: false,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const status = session.data;
  const allowedLocal = status?.required === false;
  const callbackError =
    parseLocation(window.location.hash.slice(1)).params.get('error') === 'signin_failed';

  async function logout() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Could not sign out. Please try again.');
      qc.clear();
      setLocal(false);
      navigate('/login', { replace: true });
      await session.refetch();
    } catch {
      setError('Could not sign out. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (status?.user || (local && (allowedLocal || settings.dataMode === 'mock'))) {
    return (
      <AuthContext.Provider
        value={{ user: status?.user ?? null, logout: () => void logout(), busy }}
      >
        {error && (
          <p role="alert" className="bg-err-soft p-3 text-center text-[13px] text-err">
            {error}
          </p>
        )}
        {children}
      </AuthContext.Provider>
    );
  }

  function enterLocal() {
    setLocal(true);
    navigate('/', { replace: true });
  }

  return (
    <div data-theme="light" className="min-h-dvh bg-bg text-fg">
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <a
          href="#/login"
          className="flex items-center gap-2.5 text-[16px] font-semibold tracking-tight"
        >
          <BrandMark className="size-8" />
          DaveCode
        </a>
        <a
          href="https://github.com/DMRLZZ/DaveCode"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
        >
          Open source
          <ArrowUpRight aria-hidden className="size-3.5" />
        </a>
      </header>
      <main className="mx-auto grid min-h-[calc(100dvh-7rem)] max-w-6xl items-center gap-12 px-6 pb-12 lg:grid-cols-[1.1fr_1fr] lg:gap-24 lg:px-10">
        <section aria-labelledby="welcome-story" className="hidden py-12 lg:block">
          <h1
            id="welcome-story"
            className="text-[clamp(3rem,5vw,4.4rem)] leading-[1.04] font-medium tracking-[-0.055em]"
          >
            Big ideas.
            <br />
            One place
            <br />
            <span className="text-muted">to make them real.</span>
          </h1>
          <p className="mt-7 max-w-sm text-[16px] leading-7 text-muted">
            Bring your AI tools together. Tell DaveCode what you want to do, and take it from there.
          </p>
          <ul className="mt-12 flex flex-col gap-3 text-[13px] text-fg-2">
            {[
              'Your own models and accounts',
              'Your projects stay under your control',
              'No DaveCode subscription',
            ].map((text) => (
              <li key={text} className="flex items-center gap-2.5">
                <Check aria-hidden className="size-4 text-muted" />
                {text}
              </li>
            ))}
          </ul>
        </section>
        <section
          aria-labelledby="signin-title"
          className="mx-auto w-full max-w-[360px] py-10 lg:py-16"
        >
          <h2 id="signin-title" className="text-center text-[30px] font-semibold tracking-tight">
            Make room for your ideas.
          </h2>
          <p className="mt-3 text-center text-[14px] leading-6 text-muted">
            Sign in to your DaveCode workspace.
          </p>
          <div className="mt-9 flex flex-col gap-3">
            {(['google', 'github'] as const).map((provider) => {
              const configured = status?.providers.includes(provider) ?? false;
              return (
                <button
                  key={provider}
                  type="button"
                  disabled={session.isPending || busy}
                  aria-disabled={!configured}
                  onClick={() => {
                    if (!configured) {
                      setError(
                        `${provider === 'google' ? 'Google' : 'GitHub'} sign-in is not enabled on this workspace yet. The workspace owner can enable it using the authentication setup guide.`,
                      );
                      return;
                    }
                    setError(undefined);
                    setBusy(true);
                    window.location.assign(`${base}/api/auth/${provider}/start`);
                  }}
                  className="relative flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-line-strong bg-panel px-5 text-[14px] font-medium transition-colors hover:bg-hover active:bg-active disabled:opacity-50"
                >
                  {provider === 'google' ? (
                    <GoogleMark />
                  ) : (
                    <img
                      src={`${import.meta.env.BASE_URL}github.svg`}
                      alt=""
                      aria-hidden
                      className="size-5"
                    />
                  )}
                  {busy
                    ? 'Redirecting…'
                    : `Continue with ${provider === 'google' ? 'Google' : 'GitHub'}`}
                </button>
              );
            })}
          </div>
          <div aria-live="polite" className="mt-4 text-center text-[12px] leading-5 text-muted">
            {session.isPending ? <p role="status">Checking your workspace…</p> : null}
            {(error || callbackError) && (
              <p role="alert" className="rounded-lg bg-err-soft p-3 text-err">
                {error ??
                  'Sign-in was cancelled or could not be verified. Try again, or ask the workspace owner to check your access.'}
              </p>
            )}
            {session.isError && (
              <p role="alert">
                The local gateway is unavailable. Start DaveCode to connect, or explore the demo
                below.{' '}
                <button type="button" onClick={() => void session.refetch()} className="underline">
                  Try again
                </button>
              </p>
            )}
          </div>
          {(allowedLocal || session.isError) && (
            <>
              <div className="my-6 flex items-center gap-4 text-[12px] text-muted">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
              <Button
                className="h-11 w-full rounded-xl"
                variant="ghost"
                icon={ArrowRight}
                onClick={() => {
                  if (!allowedLocal) updateSettings({ dataMode: 'mock' });
                  enterLocal();
                }}
              >
                {allowedLocal ? 'Continue on this device' : 'Explore the demo'}
              </Button>
            </>
          )}
          <p className="mt-7 text-center text-[12px] leading-5 text-muted">
            {allowedLocal
              ? 'Local mode works without a DaveCode account.'
              : 'Access is managed by the workspace owner.'}{' '}
            Connecting your AI providers comes next.
          </p>
          {(error || allowedLocal) && (
            <a
              className="mt-4 block text-center text-[12px] text-muted underline hover:text-fg"
              href="https://github.com/DMRLZZ/DaveCode/blob/main/docs/AUTH.md"
              target="_blank"
              rel="noreferrer"
            >
              Authentication setup guide
            </a>
          )}
        </section>
      </main>
    </div>
  );
}

export function SessionButton() {
  const auth = useContext(AuthContext);
  if (!auth.user) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={LogOut}
      loading={auth.busy}
      onClick={auth.logout}
      title={`Signed in as ${auth.user.name}`}
    >
      Sign out
    </Button>
  );
}
