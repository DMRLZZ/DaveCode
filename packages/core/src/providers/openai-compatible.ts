import { OpenAIProvider } from './openai';

/**
 * Any OpenAI-compatible endpoint: OpenRouter, Ollama (`http://localhost:11434/v1`), LM Studio,
 * vLLM, LiteLLM... Same wire format as {@link OpenAIProvider}, but `account.config.baseUrl` is
 * required, the API key is optional and extra headers come from `config.defaultHeaders`.
 *
 * Model ids are passed through untouched (OpenRouter ids contain slashes such as
 * `openai/gpt-4o`); only a leading `openai-compatible/` router prefix is removed.
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor() {
    super({
      kind: 'openai-compatible',
      defaultBaseUrl: undefined,
      requireBaseUrl: true,
      requireSecret: false,
    });
  }
}
