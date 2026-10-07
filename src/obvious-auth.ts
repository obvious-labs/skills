import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const DEFAULT_OBVIOUS_API_BASE_URL = 'https://api.app.obvious.ai';

/**
 * Session issued by Obvious's login-start endpoint. `expiresAt` is an ISO
 * timestamp string or epoch-milliseconds number; the CLI gives up on the
 * login flow once it passes.
 */
export interface StartLoginSessionResult {
  sessionUrl: string;
  expiresAt: string | number;
  pollUrl: string;
}

/**
 * The auth module is client-agnostic: the caller injects the Obvious skills
 * API client (see src/obvious-client.ts) so token resolution stays pure and
 * tests never touch the network.
 */
export interface ObviousAuthClient {
  /** Cheap authed call that answers whether this token still works. */
  isTokenValid(token: string, baseUrl: string): Promise<boolean>;
  /** Asks the backend for a new login session (session URL + poll URL). */
  startLoginSession(baseUrl: string): Promise<StartLoginSessionResult>;
}

/** Where the resolved token came from — mirrors the precedence order. */
export type ObviousTokenSource = 'env' | 'cache' | 'login';

export interface ResolvedObviousAuth {
  token: string;
  apiBaseUrl: string;
  source: ObviousTokenSource;
}

export interface PollForTokenOptions {
  /** Fetch stub compatible with `fetch(input, init)` — narrower than typeof fetch so test vi.fn mocks typecheck. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Delay between poll attempts; tests push this down to 0–1ms. */
  pollIntervalMs?: number;
  /** Observes how much of the session window is left before each attempt. */
  onPoll?: (msUntilExpiry: number) => void;
}

export interface ResolveObviousTokenOptions {
  client: ObviousAuthClient;
  /** Overrides the API base URL instead of OBVIOUS_API_BASE_URL/default. */
  baseUrl?: string;
  pollIntervalMs?: number;
  /** Fetch stub compatible with `fetch(input, init)` — narrower than typeof fetch so test vi.fn mocks typecheck. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * Renders the browser-session URL before polling starts. Called in every
   * login flow, including headless ones, so the user can open the URL later.
   */
  onLoginStart?: (sessionUrl: string, expiresAtMs: number) => void;
  onLoginPoll?: (msUntilExpiry: number) => void;
  /**
   * Validate a cached token with a cheap authed call before reuse.
   * Defaults to true; tests may disable it to exercise the raw cache read.
   */
  validateCachedToken?: boolean;
}

export class ObviousLoginExpiredError extends Error {
  constructor(expiresAtMs: number) {
    super(`Obvious login session expired at ${new Date(expiresAtMs).toISOString()}`);
    this.name = 'ObviousLoginExpiredError';
  }
}

function resolveConfigHome(): string {
  const fromEnv = process.env.XDG_CONFIG_HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(homedir(), '.config');
}

export function getObviousTokenCachePath(configHome?: string): string {
  return join(configHome ?? resolveConfigHome(), 'skills', 'obvious.json');
}

/** OBVIOUS_API_BASE_URL env wins over the documented default. */
export function resolveObviousApiBaseUrl(baseUrl?: string): string {
  return (
    baseUrl?.trim() || process.env.OBVIOUS_API_BASE_URL?.trim() || DEFAULT_OBVIOUS_API_BASE_URL
  );
}

function readCachedToken(configHome?: string): string | null {
  const cachePath = getObviousTokenCachePath(configHome);
  if (!existsSync(cachePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as { token?: unknown };
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    if (token) {
      return token;
    }
  } catch {
    // Corrupt cache: fall through and remove it below.
  }
  // An unreadable or token-less cache is dead weight — remove it so stale,
  // permissively-shared files don't linger once the login flow rewrites anew.
  clearObviousToken(configHome);
  return null;
}

export function writeCachedToken(token: string, configHome?: string): string {
  const cachePath = getObviousTokenCachePath(configHome);
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  writeFileSync(
    cachePath,
    `${JSON.stringify({ token, cachedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  // mode only applies on file creation; chmod so a pre-existing file is fixed too.
  chmodSync(cachePath, 0o600);
  return cachePath;
}

/** Deletes the obvious.json token cache; a no-op when it is already gone. */
export function clearObviousToken(configHome?: string): void {
  rmSync(getObviousTokenCachePath(configHome), { force: true });
}

function expiryDeadlineMs(expiresAt: string | number): number {
  const parsed = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `startLoginSession returned expiresAt (${String(expiresAt)}) that is not an ISO timestamp or epoch milliseconds`
    );
  }
  return parsed;
}

/**
 * Long-polls the backend poll URL until it hands back `{ token }` or the
 * session expiry passes. Non-2xx other than session-expiry codes and
 * unreadable response bodies fail the login flow rather than looping.
 */
export async function pollForToken(
  session: StartLoginSessionResult,
  options: PollForTokenOptions = {}
): Promise<string> {
  const sessionUrl = session.sessionUrl?.trim();
  const pollUrl = session.pollUrl?.trim();
  if (!sessionUrl || !pollUrl) {
    throw new Error('startLoginSession must return non-empty sessionUrl and pollUrl');
  }
  const deadlineMs = expiryDeadlineMs(session.expiresAt);
  const doFetch = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  for (;;) {
    const msUntilExpiry = deadlineMs - Date.now();
    if (msUntilExpiry <= 0) {
      throw new ObviousLoginExpiredError(deadlineMs);
    }
    options.onPoll?.(msUntilExpiry);

    let response: Response;
    try {
      response = await doFetch(pollUrl, { method: 'GET', headers: { accept: 'application/json' } });
    } catch (error) {
      throw new Error(
        `Failed to reach the Obvious login poll endpoint (${pollUrl}): ${String(error)}`
      );
    }
    if (response.status === 403 || response.status === 410) {
      throw new ObviousLoginExpiredError(deadlineMs);
    }
    if (!response.ok) {
      throw new Error(`Obvious login poll endpoint returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('Obvious login poll endpoint returned a response body that is not JSON');
    }
    const token = (body as { token?: unknown })?.token;
    if (typeof token === 'string' && token.trim()) {
      return token.trim();
    }
    // Still pending — wait out one interval, then check expiry again.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function runLoginFlow(
  client: ObviousAuthClient,
  baseUrl: string,
  options: ResolveObviousTokenOptions
): Promise<ResolvedObviousAuth> {
  const session = await client.startLoginSession(baseUrl);
  const expiresAtMs = expiryDeadlineMs(session.expiresAt);
  if (options.onLoginStart) {
    options.onLoginStart(session.sessionUrl, expiresAtMs);
  }
  const token = await pollForToken(session, {
    fetchImpl: options.fetchImpl,
    pollIntervalMs: options.pollIntervalMs,
    onPoll: options.onLoginPoll,
  });
  writeCachedToken(token);
  return { token, apiBaseUrl: baseUrl, source: 'login' };
}

/**
 * Resolves the workspace publish token in strict precedence order:
 * 1. OBVIOUS_API_TOKEN env override (no disk touch, CI path)
 * 2. cached token at <xdgConfig>/skills/obvious.json, validated once with a
 *    cheap authed call before reuse; an invalid or corrupt cache is cleared
 * 3. the backend-issued login session: startLoginSession → print/open the
 *    session URL → poll until { token } or expiry → cache the token at 0600
 */
export async function resolveObviousToken(
  options: ResolveObviousTokenOptions
): Promise<ResolvedObviousAuth> {
  const baseUrl = resolveObviousApiBaseUrl(options.baseUrl);

  const envToken = process.env.OBVIOUS_API_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, apiBaseUrl: baseUrl, source: 'env' };
  }

  const cached = readCachedToken();
  if (cached) {
    let valid = true;
    if (options.validateCachedToken !== false) {
      try {
        valid = await options.client.isTokenValid(cached, baseUrl);
      } catch {
        // A failing validation call is not proof the token is alive; re-login.
        valid = false;
      }
    }
    if (valid) {
      return { token: cached, apiBaseUrl: baseUrl, source: 'cache' };
    }
    clearObviousToken();
  }

  return runLoginFlow(options.client, baseUrl, options);
}
