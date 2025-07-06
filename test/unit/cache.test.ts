import { describe, it, expect, beforeEach, vitest } from "vitest";
import Keyv from "keyv";
import MultiTieredCache, { CacheEntry, Key } from "../../src/Cache";

describe("MultiTieredCache Tests", () => {
  let memoryCache: Keyv;
  let distributedCache: Keyv;

  let sut: MultiTieredCache;

  const MS_IN_A_SEC = 1000;

  const ttlM = 0.5;
  const ttlM_ms = ttlM * MS_IN_A_SEC;

  const lifetimeM = 1;
  const lifetimeM_ms = lifetimeM * MS_IN_A_SEC;

  const ttlD = 2;
  const ttlD_ms = ttlD * MS_IN_A_SEC;

  const lifetimeD = 4;
  const lifetimeD_ms = lifetimeD * MS_IN_A_SEC;

  const timeoutSoftD = 0.25;
  const timeoutStrictD = 1;

  const timeoutSoftF = 0.5;
  const timeoutStrictF = 2;

  /**
   * A "complex" object to ensure serialization is done correctly
   */
  type Input = { name: string; count: number; values: boolean[] };

  beforeEach(() => {
    vitest.useFakeTimers();

    memoryCache = new Keyv(new Map(), { namespace: "memory" });
    distributedCache = new Keyv(new Map(), { namespace: "distributed" });

    sut = new MultiTieredCache({
      memory: {
        cache: memoryCache,
        ttl: ttlM,
        lifetime: lifetimeM,
      },
      distributed: {
        cache: distributedCache,
        ttl: ttlD,
        lifetime: lifetimeD,
      },
      distributedTimeout: {
        soft: timeoutSoftD,
        strict: timeoutStrictD,
      },
      factoryTimeout: {
        soft: timeoutSoftF,
        strict: timeoutStrictF,
      },
    });
  });

  // Test get / getBatch (no timeouts/stampede)
  describe("when getting values", () => {
    const inputs: { [key: string]: Input } = {
      "#1": { name: "Case #1", count: 2, values: [true, false] },
      "#2": { name: "Case #2", count: 3, values: [false, true, false] },
      "#3": { name: "Case #3", count: 0, values: [] },
    };

    const keys = Object.keys(inputs);

    const inputBatch = new Map(Object.entries(inputs));

    // Ensure all values are fresh in both caches before every test
    // Test setup will require deleting / expiring manually
    beforeEach(async () => {
      await sut.setBatch(inputBatch);

      // We advance a single ms because comparisons of ttl is done with greater or equal,
      // this prevents off by one errors when doing advanceTimersByTimeAsync(ttlM_ms) etc
      await vitest.advanceTimersByTimeAsync(1);
    });

    describe("without factory", () => {
      it("gets fresh data from memory", async () => {
        distributedCache.clear();

        const results = await sut.getBatch(keys);

        expect(results).toMatchObject(inputBatch);
      });

      it("fetches stale data from distributed cache", async () => {
        await vitest.advanceTimersByTimeAsync(lifetimeM_ms);

        await ensureNotInCache(keys, memoryCache);

        const results = await sut.getBatch(keys);

        expect(results).toMatchObject(inputBatch);
      });

      it("puts fresh data from distributed cache into memory cache", async () => {
        await vitest.advanceTimersByTimeAsync(lifetimeM_ms);

        await ensureNotInCache(keys, memoryCache);
        await sut.getBatch(keys);

        await expectCacheEntriesFresh(keys, memoryCache);
      });

      it("puts stale data from distributed cache into memory cache as stale", async () => {
        await vitest.advanceTimersByTimeAsync(ttlD_ms);

        await ensureNotInCache(keys, memoryCache);
        await sut.getBatch(keys);

        await expectCacheEntriesStaleAtCurrentTime(keys, memoryCache);
      });

      it("does not return missing keys", async () => {
        await vitest.advanceTimersByTimeAsync(lifetimeD_ms);

        await ensureNotInCache(keys, memoryCache);
        await ensureNotInCache(keys, distributedCache);

        const results = await sut.getBatch(keys);

        expect(results).toMatchObject(new Map());
      });

      it("returns stale data when both memory and distributed caches are stale", async () => {
        await vitest.advanceTimersByTimeAsync(ttlD_ms);

        const results = await sut.getBatch(keys);

        expect(results).toMatchObject(inputBatch);
      });

      it("does not return data when memory is stale and distributed cache is missing", async () => {
        await vitest.advanceTimersByTimeAsync(ttlM_ms);
        await distributedCache.clear();

        await ensureNotInCache(keys, distributedCache);

        const results = await sut.getBatch(keys);

        expect(results).toMatchObject(new Map());
      });

      it("fetches fresh data from distributed cache when memory cache is missing and distributed cache is fresh", async () => {
        await memoryCache.clear();

        const results = await sut.getBatch(keys);

        expect(results).toMatchObject(inputBatch);
      });

      it("fetches fresh data from distributed cache when memory is stale and distributed cache is fresh", async () => {
        await vitest.advanceTimersByTimeAsync(ttlM_ms);

        await expectCacheEntriesStale(keys, memoryCache);

        const results = await sut.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        // Memory cache should now be repopulated with fresh entries
        await expectCacheEntriesFreshWithTTL(keys, memoryCache, ttlM_ms)
      });

      it("returns only available keys in a mixed batch", async () => {
        await memoryCache.delete(keys[1]);
        await memoryCache.delete(keys[2]);
        await distributedCache.delete(keys[2]);

        const results = await sut.getBatch(keys);

        const expected = new Map<Key, Input>([
          [keys[0], inputs[keys[0]]], // from memory
          [keys[1], inputs[keys[1]]], // from distributed
          // keys[2] is missing completely
        ]);

        expect(results).toMatchObject(expected);
      });
    });

    describe("with factory", () => {
      it("uses factory when missing keys", async () => {
        await vitest.advanceTimersByTimeAsync(lifetimeD_ms);

        await ensureNotInCache(keys, memoryCache);
        await ensureNotInCache(keys, distributedCache);

        let factoryResult = new Map();

        const results = await sut.getBatch(keys, async (factoryKeys) => {
          expect(factoryKeys).toMatchObject(keys);

          factoryKeys.forEach((k) => factoryResult.set(k, "12345"));

          return factoryResult;
        });

        expect(results).toMatchObject(factoryResult);
      });

      it("does not return stale data when distributed caches is stale and factory does not return key in batch", async () => {
        await vitest.advanceTimersByTimeAsync(ttlD_ms);

        let factoryResult = new Map();

        const results = await sut.getBatch(keys, async (factoryKeys) => {
          expect(factoryKeys).toMatchObject(keys);

          // Return nothing except first value
          factoryResult.set(keys[0], "only return value");

          return factoryResult;
        });

        expect(results).toMatchObject(factoryResult);
      });

      it("fetches only missing keys in a mixed batch", async () => {
        await memoryCache.delete(keys[1]);
        await memoryCache.delete(keys[2]);
        await distributedCache.delete(keys[2]);

        const factoryValue: Input = { name: "Factory#1", count: 42, values: [true] };
        const results = await sut.getBatch(keys, async (factoryKeys) => {
          expect(factoryKeys).toMatchObject([keys[2]]);

          return new Map([[keys[2], factoryValue]]);
        });

        const expected = new Map<Key, Input>([
          [keys[0], inputs[keys[0]]], // from memory
          [keys[1], inputs[keys[1]]], // from distributed
          [keys[2], factoryValue], // from factory
        ]);

        expect(results).toMatchObject(expected);
      });
    });

    describe("single-key get()", () => {
      it("returns cached value with get() when present in memory", async () => {
        const scalar = await sut.get(keys[0]);
        expect(scalar).toEqual(inputs[keys[0]]);
      });

      it("invokes factory with get() when key is missing in both caches", async () => {
        await memoryCache.clear();
        await distributedCache.clear();

        const factoryValue: Input = { name: "Factory#1", count: 42, values: [true] };
        const result = await sut.get(keys[0], async () => factoryValue);

        expect(result).toEqual(factoryValue);
      });
    });

    describe("check not off-by-one for timing", () => {
      it("treats entries as fresh when exactly at TTL boundary", async () => {
        await distributedCache.clear();
        await vitest.advanceTimersByTimeAsync(ttlM_ms - 2);

        const results = await sut.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        await expectCacheEntriesFresh(keys, memoryCache);
      });

      it("treats entries as stale when exactly one millisecond past TTL boundary", async () => {
        await vitest.advanceTimersByTimeAsync(ttlM_ms);

        await expectCacheEntriesStale(keys, memoryCache);

        const results = await sut.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        await expectCacheEntriesFresh(keys, memoryCache);
      });

      it("keeps entries in cache when exactly at lifetime boundary minus 1ms", async () => {
        await distributedCache.clear();
        await vitest.advanceTimersByTimeAsync(lifetimeM_ms - 1);

        await expectCacheEntriesExist(keys, memoryCache);
        await expectCacheEntriesStale(keys, memoryCache);
      });

      it("removes entries from cache when exactly at lifetime boundary", async () => {
        await vitest.advanceTimersByTimeAsync(lifetimeM_ms);

        await ensureNotInCache(keys, memoryCache);
      });

      it("handles mixed timing states in distributed cache at TTL boundary", async () => {
        await memoryCache.clear();
        await vitest.advanceTimersByTimeAsync(ttlD_ms);

        const results = await sut.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        await expectCacheEntriesStale(keys, distributedCache);
        await expectCacheEntriesStaleAtCurrentTime(keys, memoryCache);
      });

      it("handles boundary case when memory TTL equals distributed TTL", async () => {
        const equalTTL = 1;
        const equalTTL_ms = equalTTL * MS_IN_A_SEC;

        const equalTTLCache = new MultiTieredCache({
          memory: {
            cache: memoryCache,
            ttl: equalTTL,
            lifetime: lifetimeM,
          },
          distributed: {
            cache: distributedCache,
            ttl: equalTTL,
            lifetime: lifetimeD,
          },
          distributedTimeout: {
            soft: timeoutSoftD,
            strict: timeoutStrictD,
          },
          factoryTimeout: {
            soft: timeoutSoftF,
            strict: timeoutStrictF,
          },
        });

        await equalTTLCache.setBatch(inputBatch);
        await vitest.advanceTimersByTimeAsync(1);
        await vitest.advanceTimersByTimeAsync(equalTTL_ms);

        const results = await equalTTLCache.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        await expectCacheEntriesStale(keys, memoryCache);
        await expectCacheEntriesStale(keys, distributedCache);
      });
    });
  });

  describe("other operations", () => {
    // Test:
    //  set / setBatch
    describe("set", () => {});
    //  has / hasBatch
    describe("has", () => {});
    //  delete / deleteBatch
    describe("delete", () => {});
    //  clear
    describe("clear", () => {});
  });

  describe("when stampeding distributed cache", () => {
    // Test stampede protection on the distributed cache
  });

  describe("when distributed cache times out", () => {
    // Test timeouts (soft/strict) on the distributed cache
  });

  describe("when stampeding factory", () => {
    // Test stampede proteciton on the factory method
  });
  describe("when factory times out", () => {
    // Test timeouts (soft/strict) on the factory method
  });

  // Helper functions to reduce repetition
  async function ensureNotInCache(keys: Key[], cache: Keyv) {
    const valuesFromCache = await cache.getMany(keys, { raw: true });
    expect(valuesFromCache).toMatchObject(new Array(keys.length).map((_) => undefined));
  }

  async function expectCacheEntriesFresh(keys: Key[], cache: Keyv) {
    const entries = await cache.getMany<CacheEntry<Input>>(keys);
    expect(entries.every((e) => e !== undefined && e!.freshUntil > Date.now())).toBe(true);
  }

  async function expectCacheEntriesStale(keys: Key[], cache: Keyv) {
    const entries = await cache.getMany<CacheEntry<Input>>(keys);
    expect(entries.every((e) => e !== undefined && e!.freshUntil <= Date.now())).toBe(true);
  }

  async function expectCacheEntriesExist(keys: Key[], cache: Keyv) {
    const entries = await cache.getMany<CacheEntry<Input>>(keys);
    expect(entries.every((e) => e !== undefined)).toBe(true);
  }

  async function expectCacheEntriesFreshWithTTL(keys: Key[], cache: Keyv, ttl: number) {
    const entries = await cache.getMany<CacheEntry<Input>>(keys);
    expect(entries.every((e) => e !== undefined)).toBe(true);
    expect(entries.every((e) => e!.freshUntil === Date.now() + ttl)).toBe(true);
  }

  async function expectCacheEntriesStaleAtCurrentTime(keys: Key[], cache: Keyv) {
    const entries = await cache.getMany<CacheEntry<Input>>(keys);
    expect(entries.every((e) => e !== undefined)).toBe(true);
    expect(entries.every((e) => e!.freshUntil === Date.now())).toBe(true);
  }
});
