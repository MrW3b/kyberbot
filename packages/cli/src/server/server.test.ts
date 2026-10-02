import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock config
vi.mock('../config.js', () => ({
  getServerPort: () => 0,
  getIdentity: () => ({
    agent_name: 'TestBot',
    timezone: 'UTC',
    server: { port: 0 },
    channels: {},
  }),
  getRoot: () => '/tmp/kyberbot-test',
  getAgentName: () => 'TestBot',
  paths: {
    root: '/tmp/kyberbot-test',
    soul: '/tmp/kyberbot-test/SOUL.md',
    user: '/tmp/kyberbot-test/USER.md',
    heartbeat: '/tmp/kyberbot-test/HEARTBEAT.md',
  },
  resetConfig: vi.fn(),
}));

// Mock brain services
vi.mock('../brain/entity-graph.js', () => ({
  searchEntities: vi.fn().mockResolvedValue([]),
  getEntityContext: vi.fn().mockResolvedValue(null),
  getEntityGraphStats: vi.fn().mockResolvedValue({ entities: 0, relationships: 0 }),
}));

vi.mock('../brain/timeline.js', () => ({
  queryTimeline: vi.fn().mockResolvedValue([]),
  getTimelineStats: vi.fn().mockResolvedValue({ total: 0 }),
}));

vi.mock('../brain/hybrid-search.js', () => ({
  hybridSearch: vi.fn().mockResolvedValue([]),
}));

// Import after mocks
const { createBrainRouter } = await import('./brain-api.js');
const { authMiddleware } = await import('../middleware/auth.js');

// One token for the whole file: getApiToken() caches the first value it reads.
const TOKEN = 'test-auth-token-xyz';

/**
 * Build a minimal Express app matching the real server's route structure,
 * but without channels, static file serving, or listening on a port.
 */
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Health endpoint (public)
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      channels: [],
    });
  });

  // Brain API (authenticated)
  app.use('/brain', authMiddleware, createBrainRouter('/tmp/test-root'));

  return app;
}

describe('server routes', () => {
  let app: express.Express;

  // authMiddleware fails closed when KYBERBOT_API_TOKEN is unset, so these
  // route tests run with a token set and send it on every request.
  const api = () => request.agent(app).set('Authorization', `Bearer ${TOKEN}`);

  beforeAll(() => {
    process.env.KYBERBOT_API_TOKEN = TOKEN;
    app = createTestApp();
  });

  afterAll(() => {
    delete process.env.KYBERBOT_API_TOKEN;
  });

  describe('GET /health', () => {
    it('should return status ok', async () => {
      const res = await api().get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.channels).toEqual([]);
    });
  });

  describe('Brain API — GET /brain/health', () => {
    it('should return brain health', async () => {
      const res = await api().get('/brain/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('Brain API — GET /brain/entities', () => {
    it('should return empty results', async () => {
      const res = await api().get('/brain/entities');

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
    });

    it('should accept query parameters', async () => {
      const res = await api()
        .get('/brain/entities')
        .query({ q: 'test', type: 'person', limit: '5' });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
    });
  });

  describe('Brain API — GET /brain/entities/:nameOrId', () => {
    it('should return 404 for unknown entity', async () => {
      const res = await api().get('/brain/entities/unknown');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Entity not found');
    });
  });

  describe('Brain API — GET /brain/entities-stats', () => {
    it('should return stats', async () => {
      const res = await api().get('/brain/entities-stats');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('entities');
    });
  });

  describe('Brain API — GET /brain/timeline', () => {
    it('should return empty events', async () => {
      const res = await api().get('/brain/timeline');

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
    });
  });

  describe('Brain API — GET /brain/timeline-stats', () => {
    it('should return stats', async () => {
      const res = await api().get('/brain/timeline-stats');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total');
    });
  });

  describe('Brain API — POST /brain/search', () => {
    it('should require query in body', async () => {
      const res = await api()
        .post('/brain/search')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Query required');
    });

    it('should accept valid search', async () => {
      const res = await api()
        .post('/brain/search')
        .send({ query: 'test query' });

      expect(res.status).toBe(200);
      expect(res.body.query).toBe('test query');
      expect(res.body.results).toEqual([]);
    });
  });
});

describe('server auth integration', () => {

  it('should fail closed with 401 when the server token is unset', async () => {
    delete process.env.KYBERBOT_API_TOKEN;
    const app = createTestApp();

    const res = await request(app)
      .get('/brain/health')
      .set('Authorization', 'Bearer anything');

    expect(res.status).toBe(401);
  });

  it('should reject authenticated routes without token', async () => {
    process.env.KYBERBOT_API_TOKEN = TOKEN;
    const app = createTestApp();

    const res = await request(app).get('/brain/health');

    expect(res.status).toBe(401);
    delete process.env.KYBERBOT_API_TOKEN;
  });

  it('should accept authenticated routes with valid token', async () => {
    process.env.KYBERBOT_API_TOKEN = TOKEN;
    const app = createTestApp();

    const res = await request(app)
      .get('/brain/health')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    delete process.env.KYBERBOT_API_TOKEN;
  });

  it('should allow health endpoint without token', async () => {
    process.env.KYBERBOT_API_TOKEN = TOKEN;
    const app = createTestApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    delete process.env.KYBERBOT_API_TOKEN;
  });
});
