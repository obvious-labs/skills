/**
 * Obvious skills API client.
 *
 * Thin fetch wrapper over Obvious's workspace skills endpoints:
 * list, create, update. All payloads carry the full original SKILL.md
 * (frontmatter + body) — not the parsed markdown body.
 *
 * No business logic lives here: route decisions (create vs update vs
 * conflict) belong to the publish orchestration layer.
 */

import { sanitizeName } from './installer.ts';

/** Timeout for individual HTTP fetches (ms) — mirrors src/blob.ts's bound. */
const FETCH_TIMEOUT = 10_000;

/** Optional per-call knobs; tests override to exercise the timeout path quickly. */
export interface SkillCallOptions {
  /** Abort a request that takes longer than this. Defaults to FETCH_TIMEOUT. */
  timeoutMs?: number;
}

export interface PublishPayload {
  /** Full original SKILL.md, frontmatter + body, from parseSkillMd's rawContent. */
  content: string;
  /** Sanitized skill name, matching frontmatter `name` convention. */
  name: string;
  /** Frontmatter description. */
  description: string;
}

export interface WorkspaceSkillRef {
  skillId: string;
  name: string;
  description: string;
  updatedAt?: string;
}

export interface CreateUpdateResult {
  skillId: string;
}

/** Thrown when the API responds 401 so the caller can clear the cached token and re-login. */
export class TokenExpiredError extends Error {
  readonly status = 401;

  constructor(message: string) {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

/** Thrown for any other non-OK API response (4xx/5xx) or an unreachable server. */
export class ObviousApiError extends Error {
  /** HTTP status, or 0 when the request failed before a response was read. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ObviousApiError';
    this.status = status;
  }
}

/**
 * GET /sdk/skills/list — returns the workspace's own skills,
 * keyed by the sanitizeName-normalized skill name.
 */
export async function listWorkspaceSkills(
  token: string,
  baseUrl: string,
  options: SkillCallOptions = {}
): Promise<Map<string, WorkspaceSkillRef>> {
  const { body } = await request(token, baseUrl, 'GET', '/sdk/skills/list', undefined, options);
  const byName = new Map<string, WorkspaceSkillRef>();
  for (const item of Array.isArray(body.items) ? body.items : []) {
    if (!isRecord(item) || typeof item.skillId !== 'string' || typeof item.name !== 'string')
      continue;
    byName.set(sanitizeName(item.name), {
      skillId: item.skillId,
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    });
  }
  return byName;
}

/** POST /sdk/skills/create — creates a workspace skill record. */
export async function createSkill(
  token: string,
  baseUrl: string,
  payload: PublishPayload,
  options: SkillCallOptions = {}
): Promise<CreateUpdateResult> {
  const { status, body } = await request(
    token,
    baseUrl,
    'POST',
    '/sdk/skills/create',
    payload,
    options
  );
  return requireSkillId(status, body);
}

/** POST /sdk/skills/update — replaces the SKILL.md content of an existing record. */
export async function updateSkill(
  token: string,
  baseUrl: string,
  skillId: string,
  payload: PublishPayload,
  options: SkillCallOptions = {}
): Promise<CreateUpdateResult> {
  const { status, body } = await request(
    token,
    baseUrl,
    'POST',
    '/sdk/skills/update',
    {
      ...payload,
      skillId,
    },
    options
  );
  return requireSkillId(status, body);
}

function requireSkillId(status: number, body: Record<string, unknown>): CreateUpdateResult {
  if (typeof body.skillId !== 'string' || body.skillId.length === 0) {
    throw new ObviousApiError(status, 'response missing skillId');
  }
  return { skillId: body.skillId };
}

async function request(
  token: string,
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  { timeoutMs = FETCH_TIMEOUT }: SkillCallOptions = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
  } catch (err) {
    const errName = (err as Error).name;
    if (errName === 'TimeoutError' || errName === 'AbortError') {
      throw new ObviousApiError(0, `request to ${path} timed out after ${timeoutMs}ms`);
    }
    throw new ObviousApiError(0, `request to ${path} failed: ${(err as Error).message}`);
  }

  // Prefer a JSON error body's `error` field (quota/validation detail) over statusText.
  const fallbackMessage = response.ok ? null : await describeFailure(response);
  if (response.status === 401) throw new TokenExpiredError(fallbackMessage ?? 'unauthorized');

  if (!response.ok) throw new ObviousApiError(response.status, fallbackMessage ?? 'request failed');

  const text = await response.text();
  if (!text) return { status: response.status, body: {} };
  // A malformed 2xx body must not escape the typed error contract as a raw SyntaxError.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ObviousApiError(response.status, 'invalid JSON in response body');
  }
  if (!isRecord(parsed)) return { status: response.status, body: {} };
  return { status: response.status, body: parsed };
}

/** Reads a non-OK response's JSON error body; falls back to statusText when absent. */
async function describeFailure(response: Response): Promise<string> {
  const fallback = response.statusText || 'request failed';
  if (!response.headers.get('content-type')?.includes('application/json')) return fallback;
  try {
    const body = await response.text();
    const parsed: unknown = body ? JSON.parse(body) : undefined;
    if (isRecord(parsed) && typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Unreadable/unparseable error body — statusText is the honest fallback.
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
