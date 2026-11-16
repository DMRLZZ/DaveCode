/**
 * Decides how the installers are signed from what the environment provides. With no certificate
 * the build is exactly what it was before: an ad hoc macOS signature and an unsigned Windows
 * installer, which the operating systems warn about on download. Certificates are never in the
 * repository; CI passes them as secrets (see docs/SIGNING.md).
 */
import { join } from 'node:path';

const present = (env, ...names) => names.every((name) => Boolean(env[name]?.trim()));

/**
 * Empty secrets arrive as empty strings in CI. electron-builder reads some of these variables
 * by name, so an empty one must look unset rather than like a broken certificate.
 */
export const SIGNING_VARIABLES = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'DAVECODE_AZURE_SIGN_ENDPOINT',
  'DAVECODE_AZURE_SIGN_ACCOUNT',
  'DAVECODE_AZURE_SIGN_PROFILE',
  'DAVECODE_AZURE_SIGN_PUBLISHER',
];

/** Removes signing variables that are set but empty. Returns the names it removed. */
export function dropEmptySigningVariables(env) {
  const removed = [];
  for (const name of SIGNING_VARIABLES) {
    if (env[name] !== undefined && env[name].trim() === '') {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

/**
 * macOS: `notarized` (Developer ID certificate plus Apple credentials: opens with no warning),
 * `signed` (certificate only: still warned about, since Gatekeeper wants the notarization
 * ticket) or `adhoc` (no certificate: Privacy & Security → Open Anyway on first launch).
 */
export function macSigning(env, root) {
  if (!present(env, 'CSC_LINK') && !present(env, 'CSC_NAME')) {
    return {
      mode: 'adhoc',
      // Unsigned, the signature Electron ships with breaks once the bundle is assembled, and a
      // downloaded copy is then reported as "damaged" with no way to open it.
      // Hardened runtime would reject Electron's frameworks, which carry another team's signature.
      config: { identity: '-', hardenedRuntime: false },
    };
  }
  const notarize =
    present(env, 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER') ||
    present(env, 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID');
  // The bundled Node.js and Electron need a JIT, and they load native modules (SQLite, the
  // terminal) signed by us but built elsewhere; the hardened runtime allows neither by default.
  const entitlements = join(root, 'scripts/entitlements.mac.plist');
  return {
    mode: notarize ? 'notarized' : 'signed',
    config: {
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements,
      entitlementsInherit: entitlements,
      notarize,
    },
  };
}

/**
 * Windows: `azure` (Azure Artifact Signing, formerly Trusted Signing), `certificate` (a .pfx in
 * WIN_CSC_LINK, which electron-builder picks up by itself) or `unsigned` (SmartScreen and the
 * browser warn on download).
 */
export function winSigning(env) {
  const azure =
    present(env, 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET') &&
    present(
      env,
      'DAVECODE_AZURE_SIGN_ENDPOINT',
      'DAVECODE_AZURE_SIGN_ACCOUNT',
      'DAVECODE_AZURE_SIGN_PROFILE',
      'DAVECODE_AZURE_SIGN_PUBLISHER',
    );
  if (azure) {
    return {
      mode: 'azure',
      config: {
        azureSignOptions: {
          endpoint: env.DAVECODE_AZURE_SIGN_ENDPOINT.trim(),
          codeSigningAccountName: env.DAVECODE_AZURE_SIGN_ACCOUNT.trim(),
          certificateProfileName: env.DAVECODE_AZURE_SIGN_PROFILE.trim(),
          publisherName: env.DAVECODE_AZURE_SIGN_PUBLISHER.trim(),
        },
      },
    };
  }
  if (present(env, 'WIN_CSC_LINK')) return { mode: 'certificate', config: {} };
  return { mode: 'unsigned', config: {} };
}

/** What the build log says, so a release that went out unsigned is never a surprise. */
export function signingSummary(platform, mode) {
  if (platform === 'darwin') {
    if (mode === 'notarized') return 'macOS: signed with a Developer ID and notarized.';
    if (mode === 'signed') {
      return 'macOS: signed with a Developer ID but NOT notarized (no Apple credentials): Gatekeeper still warns.';
    }
    return 'macOS: ad hoc signature (no certificate): Gatekeeper asks for Open Anyway on first launch.';
  }
  if (platform === 'win32') {
    if (mode === 'azure') return 'Windows: signed with Azure Artifact Signing.';
    if (mode === 'certificate') return 'Windows: signed with the certificate in WIN_CSC_LINK.';
    return 'Windows: unsigned (no certificate): SmartScreen and browsers warn on download.';
  }
  return 'Linux: AppImages are not signed.';
}
