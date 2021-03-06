'use strict';

const assert = require('chai').assert;
const httpTransport = require('@bbc/http-transport');
const Catbox = require('catbox');
const Memory = require('catbox-memory');
const nock = require('nock');
const bluebird = require('bluebird');
const sinon = require('sinon');

const sandbox = sinon.sandbox.create();
const cache = require('../');
const { events } = cache;

const api = nock('http://www.example.com');

const VERSION = require('../package').version;

const defaultHeaders = {
  'cache-control': 'max-age=60'
};

const defaultResponse = {
  body: 'I am a string!',
  url: 'http://www.example.com/',
  statusCode: 200,
  elapsedTime: 40,
  headers: defaultHeaders
};

const bodySegment = {
  segment: `http-transport:${VERSION}:body`,
  id: 'GET:http://www.example.com/'
};

nock.disableNetConnect();

function createCache() {
  return new Catbox.Client(new Memory());
}

function createCacheClient(catbox, opts) {
  return httpTransport.createClient()
    .use(cache.maxAge(catbox, opts));
}

async function requestWithCache(catbox, opts) {
  return createCacheClient(catbox, opts)
    .get('http://www.example.com/')
    .asResponse();
}

describe('Max-Age', () => {
  afterEach(() => {
    nock.cleanAll();
    sandbox.restore();
  });

  it('stores cached values for the max-age value', async () => {
    const cache = createCache();
    api.get('/').reply(200, defaultResponse.body, defaultHeaders);

    const expiry = Date.now() + 60000;

    await requestWithCache(cache);
    const cached = await cache.get(bodySegment);
    const actualExpiry = cached.ttl + cached.stored;
    const differenceInExpires = actualExpiry - expiry;

    assert.deepEqual(cached.item.body, defaultResponse.body);
    assert(differenceInExpires < 1000);
  });

  it('does not create cache entries for critical errors', async () => {
    const catbox = createCache();

    api.get('/').reply(500, defaultResponse.body, defaultHeaders);

    await httpTransport
      .createClient()
      .use(cache.maxAge(catbox))
      .get('http://www.example.com/')
      .asResponse();

    const cached = await catbox.get(bodySegment);

    assert.isNull(cached);
  });

  it('does create cache entries for client errors', async () => {
    const catbox = createCache();

    api.get('/').reply(404, defaultResponse.body, defaultHeaders);

    await httpTransport
      .createClient()
      .use(cache.maxAge(catbox))
      .get('http://www.example.com/')
      .asResponse();

    const cached = await catbox.get(bodySegment);

    assert.deepEqual(cached.item.body, defaultResponse.body);
  });

  it('creates cache entries for item fetcher from another cache with the correct ttl', async () => {
    const nearCache = createCache();
    const farCache = createCache();

    api.get('/').reply(200, defaultResponse.body, defaultHeaders);

    const client = httpTransport.createClient();

    // populate the far-away cache first
    await client
      .use(cache.maxAge(farCache))
      .get('http://www.example.com/')
      .asResponse();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Populate the near cache
    await client
      .use(cache.maxAge(nearCache))
      .use(cache.maxAge(farCache))
      .get('http://www.example.com/')
      .asResponse();

    const cachedItem = await nearCache.get(bodySegment);

    assert.isBelow(cachedItem.ttl, 59950);
  });

  it('ignore cache lookup errors', async () => {
    const catbox = createCache();
    sandbox.stub(catbox, 'get').rejects(new Error('error'));

    api.get('/').reply(200, defaultResponse.body, defaultHeaders);

    const body = await httpTransport
      .createClient()
      .use(cache.maxAge(catbox, { ignoreCacheErrors: true }))
      .get('http://www.example.com/')
      .asBody();

    assert.equal(body, defaultResponse.body);
  });

  it('timeouts a cache lookup', async () => {
    const catbox = createCache();
    const cacheLookupComplete = false;
    api.get('/').reply(200, defaultResponse.body, defaultHeaders);

    sandbox.stub(catbox, 'get').callsFake(async () => {
      return await bluebird.delay(100);
    });

    const timeout = 10;
    try {
      await httpTransport
        .createClient()
        .use(cache.maxAge(catbox, { timeout }))
        .get('http://www.example.com/')
        .asBody();
    } catch (err) {
      assert.isFalse(cacheLookupComplete);
      return assert.equal(err.message, `Cache timed out after ${timeout}`);
    }
    assert.fail('Expected to throw');
  });

  it('ignores cache timeout error and requests from the system of record.', async () => {
    const catbox = createCache();
    let cacheLookupComplete = false;

    sandbox.stub(catbox, 'get').callsFake(async () => {
      await bluebird.delay(100);
      cacheLookupComplete = true;
    });
    api.get('/').reply(200, defaultResponse.body, defaultHeaders);

    const timeout = 10;
    let body;
    try {
      body = await httpTransport
        .createClient()
        .use(cache.maxAge(catbox, { timeout, ignoreCacheErrors: true }))
        .get('http://www.example.com/')
        .asBody();
    } catch (err) {
      return assert.fail(null, null, 'Failed on timeout');
    }
    assert.isFalse(cacheLookupComplete);
    assert.equal(body, defaultResponse.body);
  });

  describe('cache keys', () => {
    it('keys cache entries by method and url', async () => {
      const cache = createCache();
      api.get('/some-cacheable-path').reply(200, defaultResponse.body, defaultHeaders);

      const expiry = Date.now() + 60000;

      await createCacheClient(cache)
        .get('http://www.example.com/some-cacheable-path')
        .asResponse();

      const cached = await cache.get({
        segment: `http-transport:${VERSION}:body`,
        id: 'GET:http://www.example.com/some-cacheable-path'
      });

      const actualExpiry = cached.ttl + cached.stored;
      const differenceInExpires = actualExpiry - expiry;

      assert.deepEqual(cached.item.body, defaultResponse.body);
      assert(differenceInExpires < 1000);
    });

    it('keys cache entries by url including query strings in request url', async () => {
      const cache = createCache();
      api.get('/some-cacheable-path?d=ank').reply(200, defaultResponse.body, defaultHeaders);

      const expiry = Date.now() + 60000;

      await createCacheClient(cache)
        .get('http://www.example.com/some-cacheable-path?d=ank')
        .asResponse();

      const cached = await cache.get({
        segment: `http-transport:${VERSION}:body`,
        id: 'GET:http://www.example.com/some-cacheable-path?d=ank'
      });

      const actualExpiry = cached.ttl + cached.stored;
      const differenceInExpires = actualExpiry - expiry;

      assert.deepEqual(cached.item.body, defaultResponse.body);
      assert(differenceInExpires < 1000);
    });

    it('keys cache entries by url including query strings in query object', async () => {
      const cache = createCache();
      api.get('/some-cacheable-path?d=ank').reply(200, defaultResponse.body, defaultHeaders);

      const expiry = Date.now() + 60000;

      await createCacheClient(cache)
        .get('http://www.example.com/some-cacheable-path')
        .query('d', 'ank')
        .asResponse();

      const cached = await cache.get({
        segment: `http-transport:${VERSION}:body`,
        id: 'GET:http://www.example.com/some-cacheable-path?d=ank'
      });

      const actualExpiry = cached.ttl + cached.stored;
      const differenceInExpires = actualExpiry - expiry;

      assert.deepEqual(cached.item.body, defaultResponse.body);
      assert(differenceInExpires < 1000);
    });
  });

  it('does not store if cache control headers are non numbers', async () => {
    const cache = createCache();
    api.get('/').reply(200, defaultResponse.body, { 'cache-control': 'max-age=NAN' });

    await requestWithCache(cache);
    const cached = await cache.get(bodySegment);
    assert(!cached);
  });

  it('does not store if no cache-control', async () => {
    const cache = createCache();
    api.get('/').reply(200, defaultResponse.body, {});

    await requestWithCache(cache);
    const cached = await cache.get(bodySegment);
    assert(!cached);
  });

  it('does not store if max-age=0', async () => {
    const cache = createCache();

    api.get('/').reply(200, defaultResponse, {
      headers: {
        'cache-control': 'max-age=0'
      }
    });

    await requestWithCache(cache);
    const cached = await cache.get(bodySegment);
    assert(!cached);
  });

  it('returns a cached response when available', async () => {
    const headers = {
      'cache-control': 'max-age=0'
    };

    const cachedResponse = {
      body: 'http-transport',
      headers,
      statusCode: 200,
      url: 'http://www.example.com/',
      elapsedTime: 40
    };

    const cache = createCache();
    api.get('/').reply(200, defaultResponse, {
      headers
    });

    await cache.start();
    await cache.set(bodySegment, cachedResponse, 600);
    const res = await requestWithCache(cache);

    assert.equal(res.body, cachedResponse.body);
    assert.deepEqual(res.headers, cachedResponse.headers);
    assert.equal(res.statusCode, cachedResponse.statusCode);
    assert.equal(res.url, cachedResponse.url);
    assert.equal(res.elapsedTime, cachedResponse.elapsedTime);

    await cache.drop(bodySegment);
  });

  describe('Events', () => {
    it('emits events with name when name option is present', async () => {
      const cache = createCache();
      api.get('/').reply(200, defaultResponse.body, defaultHeaders);

      let cacheMiss = false;
      events.on('cache.ceych.miss', () => {
        cacheMiss = true;
      });

      const opts = {
        name: 'ceych'
      };

      await requestWithCache(cache, opts);
      assert.ok(cacheMiss);
    });

    it('emits a cache miss event', async () => {
      const cache = createCache();
      api.get('/').reply(200, defaultResponse.body, defaultHeaders);

      let cacheMiss = false;
      events.on('cache.miss', () => {
        cacheMiss = true;
      });

      await requestWithCache(cache);
      assert.ok(cacheMiss);
    });

    it('emits a cache hit event', async () => {
      const cache = createCache();
      api.get('/').reply(200, defaultResponse.body, defaultHeaders);

      let cacheHit = false;
      events.on('cache.hit', () => {
        cacheHit = true;
      });

      await requestWithCache(cache);
      await requestWithCache(cache);
      assert.ok(cacheHit);
    });

    it('returns a context from a cache hit event emission', async () => {
      const cache = createCache();
      api.get('/').reply(200, defaultResponse, defaultHeaders);

      let context;
      events.on('cache.hit', (ctx) => {
        context = ctx;
      });

      await requestWithCache(cache);
      await requestWithCache(cache);

      assert.instanceOf(context, httpTransport.context);
    });

    it('returns a context from a cache miss event emission', async () => {
      const cache = createCache();
      api.get('/').reply(200, defaultResponse, defaultHeaders);

      let context;
      events.on('cache.miss', (ctx) => {
        context = ctx;
      });

      await requestWithCache(cache);

      assert.instanceOf(context, httpTransport.context);
    });

    it('returns a context from a cache timeout event emission', async () => {
      const cache = createCache();
      api.get('/').reply(200, defaultResponse, defaultHeaders);

      sandbox.stub(cache, 'get').callsFake(async () => {
        await bluebird.delay(100);
      });

      let context;
      events.on('cache.timeout', (ctx) => {
        context = ctx;
      });

      try {
        await requestWithCache(cache, { timeout: 10 });
      } catch (err) {
        return assert.instanceOf(context, httpTransport.context);
      }

      assert.fail('Expected to throw');
    });

    it('returns a context from a cache error event emission', async () => {
      const cache = createCache();
      api.get('/').reply(200, defaultResponse, defaultHeaders);

      sandbox.stub(cache, 'get').rejects(new Error('error'));

      let context;
      events.on('cache.error', (ctx) => {
        context = ctx;
      });

      try {
        await requestWithCache(cache);
      } catch (err) {
        return assert.instanceOf(context, httpTransport.context);
      }

      assert.fail('Expected to throw');
    });
  });
});
