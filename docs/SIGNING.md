# Signing the desktop installers

Windows and macOS warn about any downloaded program whose publisher they cannot verify. That
is the warning people see when they download DaveCode today: the installers are built and tested
in CI, but they are not signed with a certificate either system trusts. The code cannot fix
this by itself; a certificate has to be bought or granted, and it belongs to a person or an
organization, never to the repository.

The build is ready for it. `packages/desktop/scripts/signing.mjs` reads the environment and
signs when the certificates are there. With none, the build is exactly the unsigned build it
was before. The first line of the packaging log says which one a build got, for example
`Signing: Windows: unsigned (no certificate): SmartScreen and browsers warn on download.`

## What each system needs

| System  | What removes the warning                                                 | Cost                                   |
| :------ | :----------------------------------------------------------------------- | :------------------------------------- |
| macOS   | A **Developer ID Application** certificate and **notarization** by Apple | Apple Developer Program, 99 USD a year |
| Windows | A code-signing certificate from a CA that Windows trusts (options below) | Free to about 10 USD a month           |
| Linux   | Nothing: AppImages are not signed                                        | —                                      |

### macOS

Both parts are required. A signed but not notarized app is still blocked.

1. Join the [Apple Developer Program](https://developer.apple.com/programs/).
2. Create a **Developer ID Application** certificate and export it with its private key as a
   `.p12` file with a password.
3. Create an **app-specific password** for the Apple ID at
   [account.apple.com](https://account.apple.com) (or an App Store Connect API key).

### Windows

Since 2023 every publicly trusted certificate keeps its key in hardware or in a cloud service,
so a plain `.pfx` file bought from a CA is rare. The realistic options:

- **[SignPath Foundation](https://signpath.org/)**: free code signing for open-source projects.
  DaveCode qualifies on paper (MIT license, public repository, builds on GitHub Actions). The
  certificate is issued to SignPath Foundation, which then appears as the publisher, and they
  review the project first. It signs through their own GitHub Action, not through the variables
  below, so it needs a small change to the workflow once the project is accepted.
- **Azure Artifact Signing** (formerly Trusted Signing), about 10 USD a month. Wired below.
  Check eligibility first: Microsoft limits it by country and has paused sign-up for
  individuals more than once.
- **Microsoft Store**: Microsoft signs the package. No SmartScreen warning, but users install
  from the Store rather than from a download.
- A certificate from a CA that still allows export as a `.pfx`. Wired below.

A newly signed Windows installer can still show SmartScreen for a while. SmartScreen scores
each certificate by how many people have run what it signed, and that score starts at zero. The
"unknown publisher" text goes away at once; the blue screen fades as downloads add up.

## CI configuration

Add these under **Settings → Secrets and variables → Actions** of the repository. Every one is
optional; a missing one only means that part is not signed.

| Name                          | Kind     | For                                                       |
| :---------------------------- | :------- | :-------------------------------------------------------- |
| `MAC_CSC_LINK`                | secret   | The `.p12`, base64-encoded (`base64 -i cert.p12`)         |
| `MAC_CSC_KEY_PASSWORD`        | secret   | Password of the `.p12`                                    |
| `APPLE_ID`                    | secret   | Apple ID that notarizes                                   |
| `APPLE_APP_SPECIFIC_PASSWORD` | secret   | Its app-specific password                                 |
| `APPLE_TEAM_ID`               | secret   | Team ID of the developer account                          |
| `APPLE_API_KEY_P8`            | secret   | Instead of the three above: the contents of the `.p8` key |
| `APPLE_API_KEY_ID`            | secret   | With `APPLE_API_KEY_P8`                                   |
| `APPLE_API_ISSUER`            | secret   | With `APPLE_API_KEY_P8`                                   |
| `WIN_CSC_LINK`                | secret   | A Windows `.pfx`, base64-encoded                          |
| `WIN_CSC_KEY_PASSWORD`        | secret   | Password of the `.pfx`                                    |
| `AZURE_TENANT_ID`             | secret   | Azure Artifact Signing: the app registration's tenant     |
| `AZURE_CLIENT_ID`             | secret   | Its client id                                             |
| `AZURE_CLIENT_SECRET`         | secret   | Its client secret                                         |
| `AZURE_SIGN_ENDPOINT`         | variable | For example `https://eus.codesigning.azure.net`           |
| `AZURE_SIGN_ACCOUNT`          | variable | Artifact Signing account name                             |
| `AZURE_SIGN_PROFILE`          | variable | Certificate profile name                                  |
| `AZURE_SIGN_PUBLISHER`        | variable | Publisher name on the certificate, exactly                |

The secrets reach only the step that packages the installer, not dependency installation,
linting, tests or the build before it.

## What CI checks

- macOS: the signature of the app and of the copy inside the disk image, always. When the app
  carries a Developer ID, Gatekeeper must also accept it (`spctl --assess`), which fails without
  a valid notarization.
- Windows: when a signing secret is set, the installer's Authenticode signature must be valid.

## Status

Signing with real certificates has not been run yet: no certificate exists for the project.
The unsigned path is what every release so far has used and is covered by the packaged
acceptance run. The first build with certificates should be a manual **Desktop installer** run,
checked before it is published.
