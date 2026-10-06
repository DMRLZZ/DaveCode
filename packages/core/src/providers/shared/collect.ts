import type { ChatCompletion, ChatCompletionChunk, FinishReason } from '../../types';
import { makeUsage, newId, nowSeconds } from './util';

/** Fold a chunk stream into a single non-streaming completion (text only; CLI adapters). */
export async function collectCompletion(
  chunks: AsyncIterable<ChatCompletionChunk>,
  model: string,
): Promise<ChatCompletion> {
  let id = newId();
  let outModel = model;
  let text = '';
  let finish: FinishReason = null;
  let usage = makeUsage(0, 0);
  for await (const c of chunks) {
    id = c.id;
    outModel = c.model || outModel;
    if (c.usage) usage = c.usage;
    for (const choice of c.choices) {
      if (typeof choice.delta.content === 'string') text += choice.delta.content;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return {
    id,
    object: 'chat.completion',
    created: nowSeconds(),
    model: outModel,
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: finish ?? 'stop' },
    ],
    usage,
  };
}
