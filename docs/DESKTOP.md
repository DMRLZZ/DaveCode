# DaveCode desktop for Windows

The desktop preview packages the existing workspace in an independent Electron window with
a native folder picker, File → Open project (`Ctrl+O`), File → Close project and an application
menu. The Windows x64 installer creates Start menu and desktop shortcuts, supports a per-user
installation and includes its own Node.js runtime. Users do not need to install Node or npm
to open the desktop app.

Open a folder to start. For a new workspace DaveCode asks before adding its `.davecode`
project files; existing brain files are preserved. Connect an API provider or a supported
vendor CLI in AI connections. Vendor CLIs and Git are separate tools and are not bundled.
Code execution still needs the selected project's own toolchain and a Git repository.

## Development and packaging

```bash
pnpm install
pnpm build
pnpm desktop
```

Build and verify the Windows x64 installer on Windows x64:

```bash
pnpm desktop:package
pnpm --filter @davecode/desktop smoke --packaged
```

The installer is written to `packages/desktop/release/DaveCode-Setup-0.3.0-x64.exe`.
The acceptance harness launches the packaged executable against a disposable project and
`DAVECODE_HOME`, checks authenticated and unauthenticated API requests, waits for the
workspace composer, saves `release/smoke/desktop.png` and verifies the gateway stops on exit.
It never uses the real `~/.davecode`. `pnpm --filter @davecode/desktop smoke` checks the
development build. `DaveCode.exe --project=C:\path\to\project` opens a folder at launch.

Packaging installs the CLI's pinned direct production dependencies into isolated staging,
copies the locally built CLI/dashboard and backend, and bundles the same Node executable
used to install SQLite. This avoids replacing the workspace's native SQLite dependency for
Electron. The Node license is included. Only the generated `packages/desktop/dist`, `.stage`
and `release` directories are disposable.

The installer is not code-signed until a publisher signing certificate is configured.
The desktop GitHub Actions workflow builds and tests on Windows; tags named `desktop-v*`
upload the installer to the corresponding existing GitHub release.

## Runtime boundaries

The main process starts one child gateway on `127.0.0.1` and an OS-assigned free port.
A random per-launch credential is supplied through private process IPC and attached by
Electron's main process only to requests for that exact gateway origin. The token never
appears in renderer JavaScript, URLs, localStorage or logs. The gateway's ordinary token
checks protect the API, including SSE. Account credentials remain in the engine's existing
encrypted keyring under `~/.davecode`, shared with the CLI (or `DAVECODE_HOME` when set).

The renderer uses context isolation, sandboxing, no Node integration, a restrictive content
security policy, denied permission requests and navigation boundaries. HTTPS links open in
the system browser; executable URL schemes are rejected. Project selection IPC verifies the
main window and main frame and accepts no caller-supplied filesystem path. Closing the app
or switching projects stops goals, the runner, the gateway and SQLite before shutting down the
child; a timed process-tree fallback handles a stalled shutdown.

The desktop preview does not yet embed a terminal, manage vendor CLI installations or ship
automatic updates. Official provider sign-in can open an external terminal using the bundled
Node/CLI. Gemini's upstream `UNSUPPORTED_CLIENT` limitation remains; see
[provider verification](PROVIDER-VERIFICATION.md).
