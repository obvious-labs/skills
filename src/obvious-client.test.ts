import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type ServerResponse, type Server } from 'node:http';
import {
  listWorkspaceSkills,
  createSkill,
  updateSkill,
  TokenExpiredError,
  ObviousApiError,
  type PublishPayload,
} from './obvious-client.ts';

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

type Handler = (res: ServerResponse) => void;

const TOKEN = 'test-token';

const SAMPLE_PAYLOAD: PublishPayload = {
  content: '---\nname: sample-skill\ndescription: A sample skill.\n---\n\n# Sample\n\nBody here.',
  name: 'sample-skill',
  description: 'A sample skill.',
};

describe('obvious-client', () => {
  // One shared mock server per file; each test swaps the response handler.
  let requests: RecordedRequest[];
  let handler: Handler;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    requests = [];
    handler = () => {};
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body: unknown;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }
        requests.push({
          method: req.method || '',
          url: req.url || '',
          authorization: req.headers.authorization ?? null,
          contentType: req.headers['content-type'] ?? null,
          body,
        });
        handler(res);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    requests.length = 0;
    handler = () => {};
  });

  const respondJson = (status: number, payload: unknown, contentType = 'application/json') => {
    handler = (res) => {
      res.statusCode = status;
      res.setHeader('content-type', contentType);
      res.end(JSON.stringify(payload));
    };
  };

  const respondRaw = (status: number, payload: string) => {
    handler = (res) => {
      res.statusCode = status;
      res.end(payload);
    };
  };

  it('listWorkspaceSkills GETs /sdk/skills/list and keys records by sanitized name', async () => {
    respondJson(200, {
      items: [
        {
          skillId: 'skl_abc',
          name: 'Deploy Checklist',
          description: 'd1',
          updatedAt: '2026-10-07T00:00:00Z',
        },
        { skillId: 'skl_def', name: 'triage-notes', description: 'd2' },
        { skillId: 'skl_dropped', name: 42, description: 'malformed-name-field' },
      ],
    });

    const byName = await listWorkspaceSkills(TOKEN, baseUrl);

    expect(requests).toEqual([
      {
        method: 'GET',
        url: '/sdk/skills/list',
        authorization: `Bearer ${TOKEN}`,
        contentType: null,
        body: undefined,
      },
    ]);
    expect(byName.size).toBe(2);
    expect(byName.get('deploy-checklist')).toMatchObject({
      skillId: 'skl_abc',
      description: 'd1',
      updatedAt: '2026-10-07T00:00:00Z',
    });
    expect(byName.get('triage-notes')).toMatchObject({ skillId: 'skl_def' });
  });

  it('createSkill POSTs the full payload to /sdk/skills/create', async () => {
    respondJson(201, { skillId: 'skl_new' });

    const result = await createSkill(TOKEN, baseUrl, SAMPLE_PAYLOAD);

    expect(result).toEqual({ skillId: 'skl_new' });
    expect(requests).toHaveLength(1);
    const posted = requests[0] as RecordedRequest;
    expect(posted.method).toBe('POST');
    expect(posted.url).toBe('/sdk/skills/create');
    expect(posted.contentType).toBe('application/json');
    expect(posted.body).toEqual(SAMPLE_PAYLOAD);
    // Full original SKILL.md goes on the wire verbatim, frontmatter included.
    expect((posted.body as PublishPayload).content).toContain('---\nname: sample-skill');
  });

  it('updateSkill POSTs payload + skillId to /sdk/skills/update', async () => {
    respondJson(200, { skillId: 'skl_existing' });

    const result = await updateSkill(TOKEN, baseUrl, 'skl_existing', SAMPLE_PAYLOAD);

    expect(result).toEqual({ skillId: 'skl_existing' });
    expect(requests).toHaveLength(1);
    const updated = requests[0] as RecordedRequest;
    expect(updated.method).toBe('POST');
    expect(updated.url).toBe('/sdk/skills/update');
    expect(updated.body).toEqual({ ...SAMPLE_PAYLOAD, skillId: 'skl_existing' });
  });

  it('throws TokenExpiredError on 401', async () => {
    respondJson(401, { error: 'unauthorized' });

    await expect(listWorkspaceSkills(TOKEN, baseUrl)).rejects.toBeInstanceOf(TokenExpiredError);
    await expect(createSkill(TOKEN, baseUrl, SAMPLE_PAYLOAD)).rejects.toMatchObject({
      name: 'TokenExpiredError',
      status: 401,
    });
  });

  it.each([
    [400, '/sdk/skills/create'],
    [403, '/sdk/skills/create'],
    [404, '/sdk/skills/list'],
    [409, '/sdk/skills/create'],
    [422, '/sdk/skills/update'],
  ] as const)('maps HTTP %i to ObviousApiError across client calls', async (status, route) => {
    respondJson(status, { error: `bad request ${status}` });

    let caught: unknown;
    try {
      // Route each row to the client function that actually hits that route.
      if (route === '/sdk/skills/list') await listWorkspaceSkills(TOKEN, baseUrl);
      else if (route === '/sdk/skills/update')
        await updateSkill(TOKEN, baseUrl, 'skl_x', SAMPLE_PAYLOAD);
      else await createSkill(TOKEN, baseUrl, SAMPLE_PAYLOAD);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ObviousApiError);
    const apiError = caught as ObviousApiError;
    expect(apiError.status).toBe(status);
    expect(apiError.message.length).toBeGreaterThan(0);
    expect(apiError).not.toBeInstanceOf(TokenExpiredError);
  });

  it('maps a 5xx to ObviousApiError with the status', async () => {
    respondRaw(503, 'service unavailable');

    await expect(createSkill(TOKEN, baseUrl, SAMPLE_PAYLOAD)).rejects.toMatchObject({
      name: 'ObviousApiError',
      status: 503,
    });
  });

  it('maps an unreachable server to ObviousApiError with status 0', async () => {
    // Port 1 on loopback: nothing listens there, fetch rejects without network egress.
    await expect(createSkill(TOKEN, 'http://127.0.0.1:1', SAMPLE_PAYLOAD)).rejects.toMatchObject({
      name: 'ObviousApiError',
      status: 0,
    });
  });

  it('maps a 2xx response missing skillId to a typed failure', async () => {
    respondRaw(200, '');

    await expect(createSkill(TOKEN, baseUrl, SAMPLE_PAYLOAD)).rejects.toBeInstanceOf(
      ObviousApiError
    );
    await expect(updateSkill(TOKEN, baseUrl, 'skl_x', SAMPLE_PAYLOAD)).rejects.toMatchObject({
      name: 'ObviousApiError',
      message: 'response missing skillId',
    });
  });

  it('maps a hung request to ObviousApiError via the fetch timeout', async () => {
    handler = () => {
      // Never respond; the client's own timeout must abort.
    };
    await expect(
      createSkill(TOKEN, baseUrl, SAMPLE_PAYLOAD, { timeoutMs: 50 })
    ).rejects.toMatchObject({
      name: 'ObviousApiError',
      status: 0,
      message: expect.stringContaining('timed out after 50ms'),
    });
  }, 2000);

  it('prefers a JSON error body message over statusText on failure', async () => {
    respondJson(429, { error: 'rate limit exceeded, retry after 30s' });

    await expect(createSkill(TOKEN, baseUrl, SAMPLE_PAYLOAD)).rejects.toMatchObject({
      name: 'ObviousApiError',
      status: 429,
      message: 'rate limit exceeded, retry after 30s',
    });
    await expect(updateSkill(TOKEN, baseUrl, 'skl_x', SAMPLE_PAYLOAD)).rejects.not.toBeInstanceOf(
      TokenExpiredError
    );
  });

  it('maps a 2xx with a malformed JSON body to a typed failure, not a SyntaxError', async () => {
    respondRaw(200, '<html>gateway error</html>');

    await expect(createSkill(TOKEN, baseUrl, SAMPLE_PAYLOAD)).rejects.toMatchObject({
      name: 'ObviousApiError',
      status: 200,
      message: 'invalid JSON in response body',
    });
  });
});
