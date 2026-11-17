import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dropEmptySigningVariables,
  macSigning,
  SIGNING_VARIABLES,
  signingSummary,
  winSigning,
} from '../scripts/signing.mjs';

const ROOT = join('repo', 'packages', 'desktop');

describe('macSigning', () => {
  it('keeps the ad hoc signature when there is no certificate', () => {
    expect(macSigning({}, ROOT)).toEqual({
      mode: 'adhoc',
      config: { identity: '-', hardenedRuntime: false, notarize: false },
    });
    // Apple credentials alone sign nothing.
    expect(macSigning({ APPLE_ID: 'a', APPLE_TEAM_ID: 'b' }, ROOT).mode).toBe('adhoc');
    expect(macSigning({ CSC_LINK: '   ' }, ROOT).mode).toBe('adhoc');
  });

  it('signs with the hardened runtime but does not notarize without Apple credentials', () => {
    const { mode, config } = macSigning({ CSC_LINK: 'base64', CSC_KEY_PASSWORD: 'x' }, ROOT);
    expect(mode).toBe('signed');
    expect(config).toEqual({
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: join(ROOT, 'scripts/entitlements.mac.plist'),
      entitlementsInherit: join(ROOT, 'scripts/entitlements.mac.plist'),
      notarize: false,
    });
    // An explicit identity must not be forced back to ad hoc.
    expect(config).not.toHaveProperty('identity');
  });

  it('notarizes with an Apple ID or an App Store Connect key, complete sets only', () => {
    const cert = { CSC_LINK: 'base64' };
    const appleId = { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'T' };
    const apiKey = { APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' };
    expect(macSigning({ ...cert, ...appleId }, ROOT)).toMatchObject({
      mode: 'notarized',
      config: { notarize: true, hardenedRuntime: true },
    });
    expect(macSigning({ ...cert, ...apiKey }, ROOT).mode).toBe('notarized');
    expect(macSigning({ ...cert, ...appleId, APPLE_TEAM_ID: '' }, ROOT).mode).toBe('signed');
    expect(macSigning({ ...cert, APPLE_API_KEY: '/k.p8' }, ROOT).mode).toBe('signed');
    expect(macSigning({ CSC_NAME: 'Developer ID Application: X', ...appleId }, ROOT).mode).toBe(
      'notarized',
    );
  });
});

describe('winSigning', () => {
  const azure = {
    AZURE_TENANT_ID: 't',
    AZURE_CLIENT_ID: 'c',
    AZURE_CLIENT_SECRET: 's',
    DAVECODE_AZURE_SIGN_ENDPOINT: ' https://eus.codesigning.azure.net ',
    DAVECODE_AZURE_SIGN_ACCOUNT: 'account',
    DAVECODE_AZURE_SIGN_PROFILE: 'profile',
    DAVECODE_AZURE_SIGN_PUBLISHER: 'DaveCode',
  };

  it('stays unsigned without a certificate', () => {
    expect(winSigning({})).toEqual({ mode: 'unsigned', config: {} });
    expect(winSigning({ WIN_CSC_KEY_PASSWORD: 'x' }).mode).toBe('unsigned');
  });

  it('lets electron-builder use a .pfx by itself', () => {
    expect(winSigning({ WIN_CSC_LINK: 'base64', WIN_CSC_KEY_PASSWORD: 'x' })).toEqual({
      mode: 'certificate',
      config: {},
    });
  });

  it('uses Azure signing only with the whole set, and prefers it over a .pfx', () => {
    expect(winSigning({ ...azure, WIN_CSC_LINK: 'base64' })).toEqual({
      mode: 'azure',
      config: {
        azureSignOptions: {
          endpoint: 'https://eus.codesigning.azure.net',
          codeSigningAccountName: 'account',
          certificateProfileName: 'profile',
          publisherName: 'DaveCode',
        },
      },
    });
    expect(winSigning({ ...azure, AZURE_CLIENT_SECRET: '' }).mode).toBe('unsigned');
    expect(winSigning({ ...azure, DAVECODE_AZURE_SIGN_PROFILE: undefined }).mode).toBe('unsigned');
  });
});

describe('dropEmptySigningVariables', () => {
  it('removes empty secrets and leaves everything else', () => {
    const env: Record<string, string | undefined> = {
      CSC_LINK: '',
      WIN_CSC_LINK: '  ',
      APPLE_ID: 'a@b.c',
      PATH: '',
      OTHER: '',
    };
    expect(dropEmptySigningVariables(env).sort()).toEqual(['CSC_LINK', 'WIN_CSC_LINK']);
    expect(env).toEqual({ APPLE_ID: 'a@b.c', PATH: '', OTHER: '' });
    expect(SIGNING_VARIABLES).toContain('APPLE_APP_SPECIFIC_PASSWORD');
  });
});

describe('signingSummary', () => {
  it('says plainly when a build will be warned about', () => {
    expect(signingSummary('darwin', 'notarized')).toMatch(/notarized\.$/);
    expect(signingSummary('darwin', 'signed')).toMatch(/NOT notarized/);
    expect(signingSummary('darwin', 'adhoc')).toMatch(/Open Anyway/);
    expect(signingSummary('win32', 'unsigned')).toMatch(/SmartScreen/);
    expect(signingSummary('win32', 'azure')).toMatch(/Azure/);
    expect(signingSummary('win32', 'certificate')).toMatch(/WIN_CSC_LINK/);
    expect(signingSummary('linux', 'unsigned')).toMatch(/not signed/);
  });
});
