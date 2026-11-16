type Env = Record<string, string | undefined>;

export const SIGNING_VARIABLES: readonly string[];

export function dropEmptySigningVariables(env: Env): string[];

export function macSigning(
  env: Env,
  root: string,
): {
  mode: 'adhoc' | 'signed' | 'notarized';
  config: {
    identity?: string;
    hardenedRuntime: boolean;
    gatekeeperAssess?: boolean;
    entitlements?: string;
    entitlementsInherit?: string;
    notarize?: boolean;
  };
};

export function winSigning(env: Env): {
  mode: 'unsigned' | 'certificate' | 'azure';
  config: {
    azureSignOptions?: {
      endpoint: string;
      codeSigningAccountName: string;
      certificateProfileName: string;
      publisherName: string;
    };
  };
};

export function signingSummary(platform: NodeJS.Platform, mode: string): string;
