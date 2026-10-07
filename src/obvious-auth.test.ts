import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearObviousToken,
  getObviousTokenCachePath,
  ObviousLoginExpiredError,
  pollForToken,
  resolveObviousApiBaseUrl,
  resolveObviousToken,
  writeCachedToken,
} from './obvious-auth.ts';
import type { ObviousAuthClient, StartLoginSessionResult } from './obvious-auth.ts';

function jsonBody(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function statusBody(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubClient(overrides: Partial<ObviousAuthClient> = {}): ObviousAuthClient {
  return {
    isTokenValid: vi.fn(async () => true),
    startLoginSession: vi.fn(async (): Promise<StartLoginSessionResult> => ({
      sessionUrl: 'https://obvious.test/authorize?session=s1',
      expiresAt: Date.now() + 60_000,
      pollUrl: 'https://obvious.test/poll/s1',
    })),
    ...overrides,
  };
}

describe('obvious-auth', () => {
  let configHome: string;
  let originalXdgConfigHome: string | undefined;
  let originalObviousApiToken: string | undefined;
  let originalObviousApiBaseUrl: string | undefined;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'obvious-auth-test-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    originalObviousApiToken = process.env.OBVIOUS_API_TOKEN;
    originalObviousApiBaseUrl = process.env.OBVIOUS_API_BASE_URL;
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.OBVIOUS_API_TOKEN;
    delete process.env.OBVIOUS_API_BASE_URL;
  });

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalObviousApiToken === undefined) {
      delete process.env.OBVIOUS_API_TOKEN;
    } else {
      process.env.OBVIOUS_API_TOKEN = originalObviousApiToken;
    }
    if (originalObviousApiBaseUrl === undefined) {
      delete process.env.OBVIOUS_API_BASE_URL;
    } else {
      process.env.OBVIOUS_API_BASE_URL = originalObviousApiBaseUrl;
    }
    rmSync(configHome, { recursive: true, force: true });
  });

  describe('resolveObviousApiBaseUrl', () => {
    it('falls back to the documented Obvious API default', () => {
      expect(resolveObviousApiBaseUrl()).toBe('https://api.app.obvious.ai');
    });

    it('prefers the OBVIOUS_API_BASE_URL env override', () => {
      process.env.OBVIOUS_API_BASE_URL = 'https://example.test/api';
      expect(resolveObviousApiBaseUrl()).toBe('https://example.test/api');
    });

    it('gives an explicit baseUrl argument precedence over env and default', () => {
      process.env.OBVIOUS_API_BASE_URL = 'https://example.test/api';
      expect(resolveObviousApiBaseUrl('https://chosen.test/api')).toBe('https://chosen.test/api');
    });
  });

  describe('token cache file', () => {
    it('writes obvious.json with 0600 file perms and a 0700 skills dir', () => {
      const path = writeCachedToken('secret-token');
      expect(path).toBe(getObviousTokenCachePath());
      expect((statSync(path).mode & 0o777) === 0o600).toBe(true);
      expect((statSync(join(configHome, 'skills')).mode & 0o777) === 0o700).toBe(true);
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { token: string; cachedAt: string };
      expect(parsed.token).toBe('secret-token');
      expect(typeof parsed.cachedAt).toBe('string');
    });

    it('repairs perms on a pre-existing permissive cache file', () => {
      const path = getObviousTokenCachePath();
      mkdirSync(join(configHome, 'skills'), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify({ token: 'leaky-token' }), { mode: 0o644 });
      chmodSync(path, 0o644);
      writeCachedToken('secret-token');
      expect((statSync(path).mode & 0o777) === 0o600).toBe(true);
    });

    it('clearObviousToken deletes the cache and is a no-op when absent', () => {
      writeCachedToken('secret-token');
      clearObviousToken();
      expect(existsSync(getObviousTokenCachePath())).toBe(false);
      expect(() => clearObviousToken()).not.toThrow();
    });
  });

  describe('resolveObviousToken precedence', () => {
    it('OBVIOUS_API_TOKEN wins over a cached token and never touches disk or login', async () => {
      writeCachedToken('cached-token');
      const client = stubClient();
      process.env.OBVIOUS_API_TOKEN = 'env-token';

      const resolved = await resolveObviousToken({ client });

      expect(resolved).toEqual({
        token: 'env-token',
        apiBaseUrl: 'https://api.app.obvious.ai',
        source: 'env',
      });
      expect(client.isTokenValid).not.toHaveBeenCalled();
      expect(client.startLoginSession).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(getObviousTokenCachePath(), 'utf-8')).token).toBe(
        'cached-token'
      );
    });

    it('ignores a whitespace-only env token', async () => {
      const client = stubClient();
      const fetchImpl = vi.fn(async () => jsonBody({ token: 'login-token' }));
      process.env.OBVIOUS_API_TOKEN = '   ';

      const resolved = await resolveObviousToken({ client, fetchImpl });

      expect(resolved).toMatchObject({ token: 'login-token', source: 'login' });
    });

    it('trims a padded env token', async () => {
      const client = stubClient();
      process.env.OBVIOUS_API_TOKEN = '  env-token  ';

      const resolved = await resolveObviousToken({ client });

      expect(resolved.token).toBe('env-token');
    });

    it('reuses a validate-able cached token without a login flow', async () => {
      writeCachedToken('cached-token');
      const client = stubClient();

      const resolved = await resolveObviousToken({ client, baseUrl: 'https://chosen.test/api' });

      expect(resolved).toEqual({
        token: 'cached-token',
        apiBaseUrl: 'https://chosen.test/api',
        source: 'cache',
      });
      expect(client.isTokenValid).toHaveBeenCalledTimes(1);
      expect(client.isTokenValid).toHaveBeenCalledWith('cached-token', 'https://chosen.test/api');
      expect(client.startLoginSession).not.toHaveBeenCalled();
    });

    it('skips validation when validateCachedToken is false', async () => {
      writeCachedToken('cached-token');
      const client = stubClient();

      const resolved = await resolveObviousToken({ client, validateCachedToken: false });

      expect(resolved).toMatchObject({ token: 'cached-token', source: 'cache' });
      expect(client.isTokenValid).not.toHaveBeenCalled();
    });

    it('drops an invalid cached token and runs the login flow', async () => {
      writeCachedToken('stale-token');
      const client = stubClient({ isTokenValid: vi.fn(async () => false) });
      const fetchImpl = vi.fn(async () => jsonBody({ token: 'login-token' }));

      const resolved = await resolveObviousToken({ client, fetchImpl });

      expect(resolved).toMatchObject({ token: 'login-token', source: 'login' });
      expect(client.isTokenValid).toHaveBeenCalledWith('stale-token', 'https://api.app.obvious.ai');
      expect((fetchImpl.mock.calls[0] as unknown[]).length).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(getObviousTokenCachePath(), 'utf-8')).token).toBe(
        'login-token'
      );
    });

    it('treats a failing validation call as an invalid cache, then re-logs in', async () => {
      writeCachedToken('cached-token');
      const client = stubClient({
        isTokenValid: vi.fn(async () => {
          throw new Error('boom');
        }),
      });
      const fetchImpl = vi.fn(async () => jsonBody({ token: 'login-token' }));

      const resolved = await resolveObviousToken({ client, fetchImpl });

      expect(resolved).toMatchObject({ token: 'login-token', source: 'login' });
    });

    it('ignores a corrupt cache file and logs in fresh', async () => {
      mkdirSync(join(configHome, 'skills'), { recursive: true, mode: 0o700 });
      writeFileSync(getObviousTokenCachePath(), '{not-json}');
      const client = stubClient();
      const fetchImpl = vi.fn(async () => jsonBody({ token: 'login-token' }));

      const resolved = await resolveObviousToken({ client, fetchImpl });

      expect(resolved).toMatchObject({ token: 'login-token', source: 'login' });
      expect(client.isTokenValid).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(getObviousTokenCachePath(), 'utf-8')).token).toBe(
        'login-token'
      );
    });

    it('hides a corrupt cache from the login flow before it starts', async () => {
      mkdirSync(join(configHome, 'skills'), { recursive: true, mode: 0o700 });
      writeFileSync(getObviousTokenCachePath(), '{not-json}');
      const client = stubClient();

      let cacheMissingAtLogin = false;
      const originalStart = client.startLoginSession.bind(client);
      client.startLoginSession = async (baseUrl: string) => {
        cacheMissingAtLogin = !existsSync(getObviousTokenCachePath());
        return originalStart(baseUrl);
      };

      await resolveObviousToken({
        client,
        fetchImpl: vi.fn(async () => jsonBody({ token: 'login-token' })),
      });

      expect(cacheMissingAtLogin).toBe(true);
    });
  });

  describe('login flow', () => {
    it('calls onLoginStart with the session URL and expiry, then caches the token at 0600', async () => {
      const client = stubClient();
      const expiresAtMs = Date.now() + 60_000;
      vi.mocked(client.startLoginSession).mockResolvedValueOnce({
        sessionUrl: 'https://obvious.test/authorize?session=s2',
        expiresAt: expiresAtMs,
        pollUrl: 'https://obvious.test/poll/s2',
      });
      const onLoginStart = vi.fn();
      const fetchImpl = vi.fn(async () => jsonBody({ token: 'login-token' }));

      const resolved = await resolveObviousToken({ client, fetchImpl, onLoginStart });

      expect(onLoginStart).toHaveBeenCalledWith(
        'https://obvious.test/authorize?session=s2',
        expiresAtMs
      );
      expect(resolved.source).toBe('login');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('https://obvious.test/poll/s2');
      expect((statSync(getObviousTokenCachePath()).mode & 0o777) === 0o600).toBe(true);
    });

    it('throws ObviousLoginExpiredError when the session is already expired', async () => {
      const client = stubClient();
      vi.mocked(client.startLoginSession).mockResolvedValueOnce({
        sessionUrl: 'https://obvious.test/authorize?session=s3',
        expiresAt: Date.now() - 1,
        pollUrl: 'https://obvious.test/poll/s3',
      });
      const onLoginStart = vi.fn();

      await expect(
        resolveObviousToken({ client, fetchImpl: vi.fn(), onLoginStart, pollIntervalMs: 1 })
      ).rejects.toBeInstanceOf(ObviousLoginExpiredError);
      expect(onLoginStart).toHaveBeenCalledTimes(1);
    });

    it('rejects an unparsable expiresAt', async () => {
      const client = stubClient();
      vi.mocked(client.startLoginSession).mockResolvedValueOnce({
        sessionUrl: 'https://obvious.test/authorize?session=s4',
        expiresAt: 'soon',
        pollUrl: 'https://obvious.test/poll/s4',
      });

      await expect(
        resolveObviousToken({ client, fetchImpl: vi.fn(async () => jsonBody({ token: 'x' })) })
      ).rejects.toThrow(/expiresAt/);
    });

    it('reports the session URL through onLoginStart even without a handler-independent browser', async () => {
      // Headless safety: onLoginStart is the only session-URL channel and is
      // always invoked, never gated on TTY detection.
      const client = stubClient();
      const seenUrls: string[] = [];
      const fetchImpl = vi.fn(async () => jsonBody({ token: 'login-token' }));

      await resolveObviousToken({
        client,
        fetchImpl,
        onLoginStart: (url) => {
          seenUrls.push(url);
        },
      });

      expect(seenUrls).toEqual(['https://obvious.test/authorize?session=s1']);
    });
  });

  describe('pollForToken', () => {
    const session = {
      sessionUrl: 'https://obvious.test/authorize',
      expiresAt: Date.now() + 60_000,
      pollUrl: 'https://obvious.test/poll',
    };

    it('returns the token from the first poll response and polls the given URL', async () => {
      const fetchImpl = vi.fn(async () => jsonBody({ token: ' poll-token ' }));

      await expect(pollForToken(session, { fetchImpl })).resolves.toBe('poll-token');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('https://obvious.test/poll');
    });

    it('counts empty or whitespace tokens as pending and loops until expiry', async () => {
      const fetchImpl = vi.fn(async () => jsonBody({ token: '   ' }));
      const onPoll = vi.fn();

      await expect(
        pollForToken(
          { ...session, expiresAt: Date.now() + 50 },
          { fetchImpl, pollIntervalMs: 10, onPoll }
        )
      ).rejects.toBeInstanceOf(ObviousLoginExpiredError);
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
      expect(onPoll).toHaveBeenCalled();
    });

    it('treats 403 and 410 poll responses as session expiry', async () => {
      for (const status of [403, 410]) {
        const fetchImpl = vi.fn(async () => statusBody(status));
        await expect(pollForToken(session, { fetchImpl })).rejects.toBeInstanceOf(
          ObviousLoginExpiredError
        );
      }
    });

    it('fails on other non-ok poll responses', async () => {
      const fetchImpl = vi.fn(async () => statusBody(500));

      await expect(pollForToken(session, { fetchImpl })).rejects.toThrow(/HTTP 500/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('fails when the poll endpoint is unreachable', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });

      await expect(pollForToken(session, { fetchImpl })).rejects.toThrow(
        /poll endpoint.*ECONNREFUSED/s
      );
    });

    it('fails when the poll response body is not JSON', async () => {
      const fetchImpl = vi.fn(async () => new Response('<html>wat</html>', { status: 200 }));

      await expect(pollForToken(session, { fetchImpl })).rejects.toThrow(/not JSON/);
    });

    it('rejects sessions missing a URL', async () => {
      await expect(
        pollForToken({ ...session, pollUrl: '' }, { fetchImpl: vi.fn() })
      ).rejects.toThrow(/sessionUrl and pollUrl/);
    });
  });
});
