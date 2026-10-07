import { PROVIDER_KINDS, type ProviderKind, TASK_STATUSES, taskIdSchema } from '@davecode/core';
import { z } from 'zod';

const providerKind = z.enum(PROVIDER_KINDS as [ProviderKind, ...ProviderKind[]]);

const contentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string(),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

const toolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const chatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(contentPart), z.null()]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCall).optional(),
});

/** `POST /v1/chat/completions` body. Unknown OpenAI parameters are accepted and dropped. */
export const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessage).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z
    .union([
      z.enum(['auto', 'none', 'required']),
      z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  user: z.string().optional(),
});

const positiveInt = z.number().int().positive();

const quotaLimits = z
  .object({
    tpm: positiveInt.optional(),
    rpm: positiveInt.optional(),
    tokens5h: positiveInt.optional(),
    requests5h: positiveInt.optional(),
    tokensDaily: positiveInt.optional(),
    requestsDaily: positiveInt.optional(),
  })
  .strict();

/** Keys that look like credentials must go in `secret`, never in plain `config`. */
const SECRET_KEY =
  /^(api[-_]?key|secret|client[-_]?secret|(access|refresh|session|auth|bearer)?[-_]?token|password|passwd|cookies?|authorization|credentials?)$/i;

const accountConfig = z
  .record(z.string(), z.unknown())
  .refine((config) => !Object.keys(config).some((key) => SECRET_KEY.test(key)), {
    message: 'config must not contain credentials; send them in "secret" instead',
  });

const accountFields = {
  label: z.string().trim().min(1).max(200),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  weight: z.number().min(0).max(1_000).optional(),
  limits: quotaLimits.optional(),
  config: accountConfig.optional(),
  /** API key / token. Encrypted at rest and never returned. */
  secret: z.string().min(1).max(100_000).optional(),
};

/** `POST /api/accounts` body (`AccountCreate`). */
export const accountCreateSchema = z.object({ provider: providerKind, ...accountFields }).strict();

/** `PATCH /api/accounts/:id` body (`AccountPatch`). */
export const accountPatchSchema = z
  .object({ ...accountFields, label: accountFields.label.optional() })
  .strict();

const taskText = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(50_000),
  acceptance: z.array(z.string().trim().min(1).max(2_000)).max(100),
  notes: z.string().max(50_000),
  dependsOn: z.array(z.string().min(1)).max(500),
  priority: z.number().finite(),
};

/** `POST /api/tasks` body. The task always starts PENDING. */
export const taskCreateSchema = z
  .object({
    id: taskIdSchema,
    title: taskText.title,
    description: taskText.description.optional(),
    dependsOn: taskText.dependsOn.optional(),
    priority: taskText.priority.optional(),
    acceptance: taskText.acceptance.optional(),
  })
  .strict();

/**
 * `PATCH /api/tasks/:id` body. `null` clears an optional field (`description`, `priority`,
 * `acceptance`, `notes`).
 */
export const taskPatchSchema = z
  .object({
    title: taskText.title.optional(),
    description: taskText.description.nullable().optional(),
    dependsOn: taskText.dependsOn.optional(),
    priority: taskText.priority.nullable().optional(),
    acceptance: taskText.acceptance.nullable().optional(),
    notes: taskText.notes.nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: 'send at least one field to change',
  });

/** `POST /api/runner/start` body: optional, `{}` or empty means "pick the next task". */
export const runnerStartSchema = z.object({ taskId: z.string().min(1).optional() }).strict();

export const timeseriesQuerySchema = z.object({
  minutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .default(60),
  bucketSec: z.coerce.number().int().min(1).max(86_400).default(60),
});

export const limitQuerySchema = (fallback: number, max = 1000) =>
  z.object({ limit: z.coerce.number().int().min(1).max(max).default(fallback) });
