import type { Provider, ProviderKind } from '../types';
import { AnthropicProvider } from './anthropic';
import { ClaudeCliProvider } from './claude-cli';
import { CodexCliProvider } from './codex-cli';
import { GeminiProvider } from './gemini';
import { type GeminiWebDriver, GeminiWebProvider } from './gemini-web';
import { OpenAIProvider } from './openai';
import { OpenAICompatibleProvider } from './openai-compatible';

export interface CreateProvidersOptions {
  /**
   * Driver for the EXPERIMENTAL `gemini-web` provider. Without one, that provider is still
   * registered but fails every call with an `unavailable` ProviderError.
   */
  geminiWebDriver?: GeminiWebDriver;
}

/** Build one stateless adapter per {@link ProviderKind}. */
export function createProviders(options: CreateProvidersOptions = {}): Map<ProviderKind, Provider> {
  const providers: Provider[] = [
    new OpenAIProvider(),
    new OpenAICompatibleProvider(),
    new AnthropicProvider(),
    new GeminiProvider(),
    new ClaudeCliProvider(),
    new CodexCliProvider(),
    new GeminiWebProvider(options.geminiWebDriver),
  ];
  return new Map(providers.map((p) => [p.kind, p]));
}
