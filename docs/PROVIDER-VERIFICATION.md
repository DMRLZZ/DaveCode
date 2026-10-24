# Provider verification

Manual checks on Windows with Node.js 24.13.1, 2026-10-24. These checks use the vendors'
official CLIs and login flows. Automated tests remain offline and use disposable homes.
No credentials or raw authentication responses are stored in this repository.

| Provider | Installed version | Result |
| :--- | :--- | :--- |
| Codex CLI | 0.163.0 | Live CLI and DaveCode adapter completion passed with the existing official ChatGPT login. |
| Claude Code | 2.1.309 | Live DaveCode adapter completion passed. The known global-login fallback still applies on Windows. |
| Gemini CLI | 0.65.0 | Real installation and official Google OAuth completed in a disposable home; Code Assist rejected the client with `UNSUPPORTED_CLIENT`. Successful completion remains pending. |

Codex emitted `thread.started`, `turn.started`, `item.completed` with an `agent_message`,
and `turn.completed`. Its usage included `input_tokens`, `cached_input_tokens`,
`cache_write_input_tokens`, `output_tokens` and `reasoning_output_tokens`. DaveCode returned
the expected assistant text, `finish_reason: stop`, and prompt/completion/total token counts.
The adapter probe reported 18,931 prompt tokens and 10 completion tokens.

Claude returned the expected assistant text, `finish_reason: stop`, 22,016 prompt tokens
and 16 completion tokens through DaveCode's adapter.

Gemini's backend returned `IneligibleTierError`, reason code `UNSUPPORTED_CLIENT`, with
the message that this client is no longer supported for Gemini Code Assist for individuals
and a direction to migrate to Antigravity. DaveCode classifies this as `auth`, preserving
the actionable message. An offline regression test covers that observed failure.
This is not evidence of a successful Gemini generation. A supported client/account must
complete a real adapter request before that roadmap item can be checked off.

Gemini also requires a trusted working directory for headless runs. Trust must be configured
through the official CLI for the intended directory; DaveCode does not bypass that check.

References: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/),
[Gemini authentication](https://geminicli.com/docs/get-started/authentication/),
[Gemini headless mode](https://geminicli.com/docs/cli/headless/).

## npm package verification

The prepared `@dmrlzz/davecode@0.3.0` tarball contains 101 entries, including the bundled engine,
gateway and dashboard. `npm publish --dry-run --access public --ignore-scripts` passed.
An isolated npm installation exposed the `davecode` command, reported version 0.3.0,
and started a gateway with a disposable `DAVECODE_HOME` on port 4041. Both its health
endpoint and bundled dashboard returned HTTP 200. The temporary gateway was stopped
after verification. The development gateway and Vite UI remain on ports 4040 and 5173.

Repository validation passed: lint, strict typecheck, 79 test files / 727 tests, and build.
Registry publication succeeded on 2026-10-24 as `@dmrlzz/davecode@0.3.0`. npm rejected the
unscoped name `davecode` for similarity to `dave-code`, so the package uses the publisher's
scope. The executable name remains `davecode`. npm's automated validation completed and
the registry's `latest` tag resolves to 0.3.0. The public version page contains the expected
README, MIT license and nine dependencies.
An independent installation from the public registry added 118 packages, exposed the
`davecode` executable and reported 0.3.0. Its gateway started with a disposable home on
port 4041; health reported `ok` / 0.3.0 and the bundled dashboard returned HTTP 200.
The temporary verification gateway was stopped afterwards.
