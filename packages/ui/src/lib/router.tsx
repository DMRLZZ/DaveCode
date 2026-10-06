import { type AnchorHTMLAttributes, useSyncExternalStore } from 'react';

/**
 * A tiny hash router. Hash URLs (`#/tasks?task=p2-router`) work behind the gateway's SPA
 * fallback, under any sub-path and from `vite preview`, with relative asset paths.
 */

export interface HashLocation {
  path: string;
  params: URLSearchParams;
}

function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function parseLocation(hash: string): HashLocation {
  const [path = '/', query = ''] = hash.split('?');
  return { path: path === '' ? '/' : path, params: new URLSearchParams(query) };
}

export function useLocation(): HashLocation {
  const hash = useSyncExternalStore(subscribe, readHash, () => '/');
  return parseLocation(hash);
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (opts.replace) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

/** Update one query param on the current route without adding a history entry. */
export function setParam(key: string, value: string | null): void {
  const { path, params } = parseLocation(readHash());
  if (value === null) params.delete(key);
  else params.set(key, value);
  const qs = params.toString();
  navigate(qs ? `${path}?${qs}` : path, { replace: true });
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

export function Link({ to, ...rest }: LinkProps) {
  return <a href={`#${to}`} {...rest} />;
}
