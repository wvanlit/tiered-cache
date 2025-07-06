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

        const inMemoryCache = await memoryCache.getMany<CacheEntry<Input>>(keys);

        expect(inMemoryCache.every((e) => e !== undefined)).toBe(true);
        expect(inMemoryCache.every((e) => e!.freshUntil === Date.now() + ttlM_ms)).toBe(true);
        expect(inMemoryCache.map((e) => e!.value)).toMatchObject(inputBatch.values());
      });

      it("puts stale data from distributed cache into memory cache as stale", async () => {
        await vitest.advanceTimersByTimeAsync(ttlD_ms);

        await ensureNotInCache(keys, memoryCache);
        await sut.getBatch(keys);

        const inMemoryCache = await memoryCache.getMany<CacheEntry<Input>>(keys);

        expect(inMemoryCache.every((e) => e !== undefined)).toBe(true);
        expect(inMemoryCache.every((e) => e!.freshUntil === Date.now())).toBe(true);
        expect(inMemoryCache.map((e) => e!.value)).toMatchObject(inputBatch.values());
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

      it("does not return data when memory cache is stale and distributed cache is missing", async () => {
        await vitest.advanceTimersByTimeAsync(ttlM_ms);
        await distributedCache.clear();

        const results = await sut.getBatch(keys);

        expect(results).toMatchObject(new Map());
      });

      it("fetches fresh data from distributed cache when memory is stale and distributed cache is fresh", async () => {
        // advance just past memory TTL so entries exist but are stale
        await vitest.advanceTimersByTimeAsync(ttlM_ms);

        // memory entries should now be stale but still present
        const staleEntries = await memoryCache.getMany<CacheEntry<Input>>(keys);
        expect(staleEntries.every((e) => e !== undefined && e!.freshUntil <= Date.now())).toBe(true);

        // fetch via cache – should come from distributed (still fresh)
        const results = await sut.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        // memory cache should now be repopulated with fresh entries
        const inMemoryAfter = await memoryCache.getMany<CacheEntry<Input>>(keys);
        expect(inMemoryAfter.every((e) => e !== undefined)).toBe(true);
        expect(inMemoryAfter.every((e) => e!.freshUntil === Date.now() + ttlM_ms)).toBe(true);
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
        // Make sure we get from the correct cache
        await distributedCache.clear();

        // Minus 1ms to ensure still fresh (+ we advance by 1ms in setup)
        await vitest.advanceTimersByTimeAsync(ttlM_ms - 2);

        const results = await sut.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        // Verify memory cache entries are still considered fresh
        const memoryEntries = await memoryCache.getMany<CacheEntry<Input>>(keys);
        expect(memoryEntries.every((e) => e !== undefined && e!.freshUntil > Date.now())).toBe(true);
      });

      it("treats entries as stale when exactly one millisecond past TTL boundary", async () => {
        // Advance to exactly the TTL boundary
        await vitest.advanceTimersByTimeAsync(ttlM_ms);

        // Check memory entries before getBatch call - they should be stale
        const memoryEntriesBefore = await memoryCache.getMany<CacheEntry<Input>>(keys);
        expect(memoryEntriesBefore.every((e) => e !== undefined && e!.freshUntil <= Date.now())).toBe(true);

        const results = await sut.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        // After getBatch, memory cache should be repopulated with fresh entries from distributed cache
        const memoryEntriesAfter = await memoryCache.getMany<CacheEntry<Input>>(keys);
        expect(memoryEntriesAfter.every((e) => e !== undefined && e!.freshUntil > Date.now())).toBe(true);
      });

      it("keeps entries in cache when exactly at lifetime boundary minus 1ms", async () => {
        // Make sure we get from the correct cache
        await distributedCache.clear();
        
        // Advance to exactly the lifetime boundary minus 1ms
        await vitest.advanceTimersByTimeAsync(lifetimeM_ms - 1);

        // Entries should still exist in memory cache even though they're stale
        const memoryEntries = await memoryCache.getMany<CacheEntry<Input>>(keys);
        expect(memoryEntries.every((e) => e !== undefined)).toBe(true);
        expect(memoryEntries.every((e) => e!.freshUntil <= Date.now())).toBe(true);
      });

      it("removes entries from cache when exactly at lifetime boundary", async () => {
        // Advance to exactly the lifetime boundary
        await vitest.advanceTimersByTimeAsync(lifetimeM_ms);

        // Entries should be removed from memory cache
        await ensureNotInCache(keys, memoryCache);
      });

      it("handles mixed timing states in distributed cache at TTL boundary", async () => {
        // Clear memory cache and advance distributed cache to TTL boundary
        await memoryCache.clear();
        await vitest.advanceTimersByTimeAsync(ttlD_ms);

        const results = await sut.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        // Verify distributed entries are considered stale
        const distributedEntries = await distributedCache.getMany<CacheEntry<Input>>(keys);
        expect(distributedEntries.every((e) => e !== undefined && e!.freshUntil <= Date.now())).toBe(true);

        // Verify they are populated into memory cache as stale
        const memoryEntries = await memoryCache.getMany<CacheEntry<Input>>(keys);
        expect(memoryEntries.every((e) => e !== undefined && e!.freshUntil === Date.now())).toBe(true);
      });

      it("handles boundary case when memory TTL equals distributed TTL", async () => {
        // Create a cache configuration where memory and distributed TTL are equal
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

        // Advance to exactly the TTL boundary
        await vitest.advanceTimersByTimeAsync(equalTTL_ms);

        const results = await equalTTLCache.getBatch(keys);
        expect(results).toMatchObject(inputBatch);

        // Both caches should have stale entries
        const memoryEntries = await memoryCache.getMany<CacheEntry<Input>>(keys);
        const distributedEntries = await distributedCache.getMany<CacheEntry<Input>>(keys);

        expect(memoryEntries.every((e) => e !== undefined && e!.freshUntil <= Date.now())).toBe(true);
        expect(distributedEntries.every((e) => e !== undefined && e!.freshUntil <= Date.now())).toBe(true);
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

  async function ensureNotInCache(keys: Key[], cache: Keyv) {
    const valuesFromCache = await cache.getMany(keys, { raw: true });
    expect(valuesFromCache).toMatchObject(new Array(keys.length).map((_) => undefined));
  }
});
