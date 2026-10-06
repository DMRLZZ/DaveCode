import { BookOpen, ExternalLink, Keyboard, Monitor, Moon, PlugZap, Sun } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Callout } from '../components/ui/Callout';
import { Field, Input } from '../components/ui/Field';
import { PageHeader, Panel, PanelHeader } from '../components/ui/Panel';
import { Segmented } from '../components/ui/Segmented';
import { createHttpClient, errorMessage } from '../lib/api';
import { useData } from '../lib/data';
import { formatDuration } from '../lib/format';
import { useHealth } from '../lib/queries';
import {
  type DataMode,
  mockForced,
  type ThemePref,
  updateSettings,
  useSettings,
} from '../lib/settings';
import { toast } from '../lib/toast';
import { ui } from '../lib/ui-state';
import { isValidUrl, SecretInput } from './accounts/forms';

const REPO = 'https://github.com/DMRLZZ/DaveCode';

export function Settings() {
  const settings = useSettings();
  const health = useHealth();
  const { connection } = useData();
  const [gatewayUrl, setGatewayUrl] = useState(settings.gatewayUrl);
  const [token, setToken] = useState(settings.token);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const validate = (): string | null => {
    const url = gatewayUrl.trim();
    if (url && !isValidUrl(url))
      return 'Enter an http(s) origin such as http://127.0.0.1:4040, or leave empty.';
    return null;
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const err = validate();
    setUrlError(err);
    if (err) return;
    updateSettings({ gatewayUrl: gatewayUrl.trim().replace(/\/+$/, ''), token: token.trim() });
    toast({
      tone: 'ok',
      title: 'Connection settings saved',
      description: 'Stored in this browser only.',
    });
  };

  const test = async () => {
    const err = validate();
    setUrlError(err);
    if (err) return;
    setTesting(true);
    setTestResult(null);
    try {
      const h = await createHttpClient({
        baseUrl: gatewayUrl.trim(),
        token: token.trim(),
      }).health();
      setTestResult({
        ok: true,
        text: `Connected: DaveCode ${h.version}, ${h.status}, up ${formatDuration(h.uptimeSec)}.`,
      });
    } catch (e) {
      setTestResult({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const forced = mockForced();

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <PageHeader
        title="Settings"
        description="Preferences are stored in this browser's localStorage."
      />

      <Panel aria-labelledby="conn-title">
        <PanelHeader id="conn-title" title="Gateway connection" />
        <form onSubmit={save} noValidate className="flex flex-col gap-4 p-4">
          <Field
            label="Gateway URL"
            error={urlError}
            hint="Leave empty when the dashboard is served by the gateway or the Vite dev proxy (same origin)."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="url"
                value={gatewayUrl}
                placeholder="same origin"
                onChange={(e) => setGatewayUrl(e.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                className="font-mono"
              />
            )}
          </Field>
          <Field
            label="Bearer token"
            hint="Needed when server.authToken is set. Sent as Authorization: Bearer, and as ?token= for the event stream."
          >
            {({ id, describedBy }) => (
              <SecretInput
                id={id}
                value={token}
                onChange={setToken}
                placeholder="not set"
                describedBy={describedBy}
              />
            )}
          </Field>
          {testResult && (
            <Callout
              tone={testResult.ok ? 'info' : 'err'}
              title={testResult.ok ? 'Gateway reachable' : 'Connection failed'}
            >
              {testResult.text}
            </Callout>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary">
              Save
            </Button>
            <Button icon={PlugZap} onClick={test} loading={testing}>
              Test connection
            </Button>
            {connection.unauthorized && <Badge tone="err">gateway returned 401</Badge>}
          </div>
        </form>
      </Panel>

      <Panel aria-labelledby="data-title">
        <PanelHeader id="data-title" title="Data source" />
        <div className="flex flex-col gap-3 p-4">
          <Segmented<DataMode>
            label="Data source"
            value={settings.dataMode}
            onChange={(v) => updateSettings({ dataMode: v })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'live', label: 'Live only' },
              { value: 'mock', label: 'Mock data' },
            ]}
          />
          <p className="text-[12px] leading-5 text-muted">
            <strong className="font-medium text-fg-2">Auto</strong> uses the gateway and falls back
            to simulated data when it is unreachable, re-checking every 15 s.{' '}
            <strong className="font-medium text-fg-2">Mock data</strong> always simulates a busy
            gateway, handy for demos and screenshots.
          </p>
          {forced && (
            <Callout tone="info">
              Mock mode is currently forced by <code className="font-mono">?mock=1</code> or{' '}
              <code className="font-mono">VITE_DAVECODE_MOCK=1</code>; this setting applies once
              that is removed.
            </Callout>
          )}
        </div>
      </Panel>

      <Panel aria-labelledby="look-title">
        <PanelHeader id="look-title" title="Appearance" />
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Segmented<ThemePref>
            label="Theme"
            value={settings.theme}
            onChange={(v) => updateSettings({ theme: v })}
            options={[
              { value: 'dark', label: 'Dark', icon: Moon },
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'system', label: 'System', icon: Monitor },
            ]}
          />
          <Button variant="ghost" icon={Keyboard} onClick={ui.openHelp}>
            Keyboard shortcuts
          </Button>
        </div>
      </Panel>

      <Panel aria-labelledby="about-title">
        <PanelHeader id="about-title" title="About" />
        <div className="flex flex-col gap-3 p-4 text-[13px]">
          <dl className="grid grid-cols-[120px_1fr] gap-y-1.5">
            <dt className="text-muted">Gateway</dt>
            <dd className="font-mono text-fg-2">
              {health.data
                ? `v${health.data.version} · ${health.data.status}`
                : connection.mode === 'probing'
                  ? 'checking…'
                  : 'unreachable'}
            </dd>
            <dt className="text-muted">Data</dt>
            <dd className="text-fg-2">
              {connection.mode === 'mock' ? 'Simulated (mock mode)' : 'Live gateway'}
            </dd>
            <dt className="text-muted">Experimental</dt>
            <dd className="flex flex-wrap gap-1.5">
              <Badge tone={health.data?.experimental.geminiWeb ? 'warn' : 'neutral'} mono>
                geminiWeb {health.data?.experimental.geminiWeb ? 'on' : 'off'}
              </Badge>
              <Badge
                tone={health.data?.experimental.multiAccountRotation ? 'warn' : 'neutral'}
                mono
              >
                multiAccountRotation {health.data?.experimental.multiAccountRotation ? 'on' : 'off'}
              </Badge>
            </dd>
          </dl>
          <ul className="flex flex-wrap gap-2">
            {[
              ['README', `${REPO}#readme`],
              ['Architecture', `${REPO}/blob/main/docs/ARCHITECTURE.md`],
              ['HTTP API', `${REPO}/blob/main/docs/API.md`],
            ].map(([label, href]) => (
              <li key={label}>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] text-fg-2 transition-colors duration-150 hover:border-line-strong hover:text-fg"
                >
                  <BookOpen aria-hidden className="size-3.5" strokeWidth={1.75} />
                  {label}
                  <ExternalLink aria-hidden className="size-3 text-muted" strokeWidth={1.75} />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </div>
  );
}
