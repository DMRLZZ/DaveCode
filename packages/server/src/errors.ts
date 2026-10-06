import { ProviderError, RouterError } from '@davecode/core';
import type { FastifyReply } from 'fastify';

/** `/api/*` error envelope. */
export function sendApiError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { message, code } });
}

/** OpenAI-compatible error body used on `/v1/*` (also inside SSE error frames). */
export interface OpenAIErrorBody {
  message: string;
  type: string;
  code: string | null;
}

export function sendOpenAIError(
  reply: FastifyReply,
  status: number,
  body: OpenAIErrorBody,
): FastifyReply {
  return reply.code(status).send({ error: body });
}

function openAIType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 404 || status === 400 || status === 422) return 'invalid_request_error';
  if (status === 429) return 'rate_limit_error';
  return 'api_error';
}

/** Map a routing failure to an HTTP status and OpenAI error body. */
export function describeRoutingError(err: unknown): { status: number; body: OpenAIErrorBody } {
  if (err instanceof RouterError) {
    return {
      status: err.status,
      body: { message: err.message, type: openAIType(err.status), code: err.code },
    };
  }
  if (err instanceof ProviderError) {
    let status: number;
    let code: string = err.kind;
    switch (err.kind) {
      case 'bad_request':
        status = 400;
        break;
      case 'context_length':
        status = 400;
        code = 'context_length_exceeded';
        break;
      case 'rate_limit':
      case 'quota_exhausted':
        status = 429;
        break;
      case 'auth':
        // The client's request is fine; DaveCode's upstream credentials are not.
        status = 502;
        code = 'upstream_auth_error';
        break;
      default:
        status = 502;
    }
    return { status, body: { message: err.message, type: openAIType(status), code } };
  }
  return {
    status: 500,
    body: { message: 'Internal gateway error', type: 'api_error', code: 'internal_error' },
  };
}
