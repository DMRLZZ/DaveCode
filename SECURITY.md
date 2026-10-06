# Security Policy

DaveCode handles API keys, OAuth tokens and browser sessions, so we take security reports
seriously.

## Supported versions

Until `1.0`, only the latest released minor version receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue.** Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/DMRLZZ/DaveCode/security/advisories/new).

Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected versions/commits and your environment.

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation within 30 days for
confirmed issues. We are happy to credit reporters in the release notes.

## Security model

- The gateway binds to `127.0.0.1` by default. If you expose it on another interface, set
  `server.authToken`.
- Secrets are encrypted at rest with AES-256-GCM using a per-install master key stored in
  `~/.davecode/master.key` with owner-only permissions. Anyone with access to your user account
  can read that key; DaveCode does not protect against a compromised local user.
- Secrets are write-only through the API and must never appear in logs or events.
- The autonomous runner executes your project's lint/test commands and model-proposed edits
  inside your repository on an isolated branch. Review what you merge to protected branches.
