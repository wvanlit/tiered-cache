import { describe, it, expect, beforeEach, vitest } from "vitest";
import Keyv, { StoredDataRaw } from "keyv";
import MultiTieredCache, { CacheEntry, Key, Seconds } from "../../src/Cache";

describe("MultiTieredCache Tests", () => {
  let memoryCache: Keyv;
  let distributedCache: Keyv;

  let sut: MultiTieredCache;

  const MS_IN_A_SEC = 1000;

  const ttlM = 5;
  const ttlM_ms = ttlM * MS_IN_A_SEC;

  const lifetimeM = 10;
  const lifetimeM_ms = lifetimeM * MS_IN_A_SEC;

  const ttlD = 20;
  const ttlD_ms = ttlD * MS_IN_A_SEC;

  const lifetimeD = 40;
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

        await expectCacheEntriesDoNotExist(keys, memoryCache);

        const results = await sut.getBatch(keys);

        expect(results).toMatchObject(inputBatch);
      });

      it("puts fresh data from distributed cache into memory cache", async () => {
        await vitest.advanceTimersByTimeAsync(lifetimeM_ms);

        await expectCacheEntriesDoNotExist(keys, memoryCache);
        await sut.getBatch(keys);

        await expectCacheEntriesFresh(keys, memoryCache);
      });

      it("puts stale data from distributed cache into memory cache as stale", async () => {
        await vitest.advanceTimersByTimeAsync(ttlD_ms);

        await expectCacheEntriesDoNotExist(keys, memoryCache);
        await sut.getBatch(keys);

        await expectCacheEntriesStaleAtCurrentTime(keys, memoryCache);
      });

      it("does not return missing keys", async () => {
        await vitest.advanceTimersByTimeAsync(lifetimeD_ms);

        await expectCacheEntriesDoNotExist(keys, memoryCache);
        await expectCacheEntriesDoNotExist(keys, distributedCache);

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

        await expectCacheEntriesDoNotExist(keys, distributedCache);

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
        await expectCacheEntriesFreshWithTTL(keys, memoryCache, ttlM_ms);
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

        await expectCacheEntriesDoNotExist(keys, memoryCache);
        await expectCacheEntriesDoNotExist(keys, distributedCache);

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

        await expectCacheEntriesDoNotExist(keys, memoryCache);
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
    const testKey = "test-key";
    const testValue: Input = { name: "Test Value", count: 1, values: [true] };
    const testBatch = new Map([
      ["key1", { name: "Value 1", count: 1, values: [true] }],
      ["key2", { name: "Value 2", count: 2, values: [false, true] }],
    ]);

    describe("set", () => {
      it("sets value in both memory and distributed caches", async () => {
        await sut.set(testKey, testValue);

        const memoryEntry = await memoryCache.get<CacheEntry<Input>>(testKey);
        const distributedEntry = await distributedCache.get<CacheEntry<Input>>(testKey);

        expect(memoryEntry?.value).toEqual(testValue);
        expect(distributedEntry?.value).toEqual(testValue);
      });

      it("sets fresh entries by default", async () => {
        await sut.set(testKey, testValue);

        const memoryEntry = await memoryCache.get<CacheEntry<Input>>(testKey);
        const distributedEntry = await distributedCache.get<CacheEntry<Input>>(testKey);

        expect(memoryEntry?.freshUntil).toBeGreaterThan(Date.now());
        expect(distributedEntry?.freshUntil).toBeGreaterThan(Date.now());
      });
    });

    describe("setBatch", () => {
      it("sets multiple values in both caches", async () => {
        await sut.setBatch(testBatch);

        const memoryEntries = await memoryCache.getMany<CacheEntry<Input>>(Array.from(testBatch.keys()));
        const distributedEntries = await distributedCache.getMany<CacheEntry<Input>>(Array.from(testBatch.keys()));

        expect(memoryEntries[0]?.value).toEqual(testBatch.get("key1"));
        expect(memoryEntries[1]?.value).toEqual(testBatch.get("key2"));
        expect(distributedEntries[0]?.value).toEqual(testBatch.get("key1"));
        expect(distributedEntries[1]?.value).toEqual(testBatch.get("key2"));
      });

      it("sets fresh entries by default", async () => {
        await sut.setBatch(testBatch);

        const memoryEntries = await memoryCache.getMany<CacheEntry<Input>>(Array.from(testBatch.keys()));
        const distributedEntries = await distributedCache.getMany<CacheEntry<Input>>(Array.from(testBatch.keys()));

        expect(memoryEntries.every((e) => e?.freshUntil && e.freshUntil > Date.now())).toBe(true);
        expect(distributedEntries.every((e) => e?.freshUntil && e.freshUntil > Date.now())).toBe(true);
      });
    });

    describe("has", () => {
      it("returns true when key exists in memory cache", async () => {
        await memoryCache.set(testKey, { value: testValue, freshUntil: Date.now() + 1000 });

        const result = await sut.has(testKey);

        expect(result).toBe(true);
      });

      it("returns true when key exists in distributed cache", async () => {
        await distributedCache.set(testKey, { value: testValue, freshUntil: Date.now() + 1000 });

        const result = await sut.has(testKey);

        expect(result).toBe(true);
      });

      it("returns false when key does not exist in either cache", async () => {
        const result = await sut.has("non-existent-key");

        expect(result).toBe(false);
      });
    });

    describe("delete", () => {
      it("removes key from both memory and distributed caches", async () => {
        await memoryCache.set(testKey, { value: testValue, freshUntil: Date.now() + 1000 });
        await distributedCache.set(testKey, { value: testValue, freshUntil: Date.now() + 1000 });

        await sut.delete(testKey);

        const memoryResult = await memoryCache.has(testKey);
        const distributedResult = await distributedCache.has(testKey);

        expect(memoryResult).toBe(false);
        expect(distributedResult).toBe(false);
      });

      it("handles deletion of non-existent key gracefully", async () => {
        await expect(sut.delete("non-existent-key")).resolves.not.toThrow();
      });
    });

    describe("deleteBatch", () => {
      it("removes multiple keys from both caches", async () => {
        const keys = ["key1", "key2"];
        await memoryCache.set("key1", { value: testValue, freshUntil: Date.now() + 1000 });
        await memoryCache.set("key2", { value: testValue, freshUntil: Date.now() + 1000 });
        await distributedCache.set("key1", { value: testValue, freshUntil: Date.now() + 1000 });
        await distributedCache.set("key2", { value: testValue, freshUntil: Date.now() + 1000 });

        await sut.deleteBatch(keys);

        const memoryResults = await memoryCache.hasMany(keys);
        const distributedResults = await distributedCache.hasMany(keys);

        expect(memoryResults.every((r) => r === false)).toBe(true);
        expect(distributedResults.every((r) => r === false)).toBe(true);
      });

      it("handles deletion of non-existent keys gracefully", async () => {
        await expect(sut.deleteBatch(["non-existent-1", "non-existent-2"])).resolves.not.toThrow();
      });
    });

    describe("clear", () => {
      it("removes all entries from both caches", async () => {
        await memoryCache.set("key1", { value: testValue, freshUntil: Date.now() + 1000 });
        await memoryCache.set("key2", { value: testValue, freshUntil: Date.now() + 1000 });
        await distributedCache.set("key1", { value: testValue, freshUntil: Date.now() + 1000 });
        await distributedCache.set("key2", { value: testValue, freshUntil: Date.now() + 1000 });

        await sut.clear();

        const memoryResult1 = await memoryCache.has("key1");
        const memoryResult2 = await memoryCache.has("key2");
        const distributedResult1 = await distributedCache.has("key1");
        const distributedResult2 = await distributedCache.has("key2");

        expect(memoryResult1).toBe(false);
        expect(memoryResult2).toBe(false);
        expect(distributedResult1).toBe(false);
        expect(distributedResult2).toBe(false);
      });
    });
  });

  describe.skip("when stampeding distributed cache", () => {
    // Test stampede protection on the distributed cache
  });

  describe.skip("when stampeding factory", () => {
    // Test stampede proteciton on the factory method
  });

  describe("when distributed cache times out", () => {
    // Test timeouts (soft/strict) on the distributed cach
    const inputs: { [key: string]: Input } = {
      "#1": { name: "Case #1", count: 2, values: [true, false] },
      "#2": { name: "Case #2", count: 3, values: [false, true, false] },
    };

    const keys = Object.keys(inputs);
    const inputBatch = new Map(Object.entries(inputs));

    let delayedGetMany: (keys: Key[], delay: Seconds) => Promise<StoredDataRaw<unknown>[]>;

    beforeEach(async () => {
      await sut.setBatch(inputBatch);
      await vitest.advanceTimersByTimeAsync(1);

      const originalGetMany = distributedCache.getMany;
      delayedGetMany = (keys: Key[], delay: Seconds) => {
        return new Promise((resolve) => setTimeout(resolve, delay * MS_IN_A_SEC)).then(() =>
          originalGetMany.call(distributedCache, keys),
        );
      };
    });

    it("returns stale memory data when distributed cache soft timeout occurs", async () => {
      // Make memory cache stale so it needs to check distributed cache
      await vitest.advanceTimersByTimeAsync(ttlM_ms);
      await expectCacheEntriesStale(keys, memoryCache);

      // Mock distributed cache to be slow (exceeds soft timeout)
      distributedCache.getMany = vitest.fn().mockImplementation((k) => delayedGetMany(k, timeoutSoftD + 0.01));

      const action = sut.getBatch(keys);

      await advanceSeconds(timeoutSoftD);

      const results = await action;

      expect(results).toMatchObject(inputBatch);
      expect(distributedCache.getMany).toHaveBeenCalledWith(keys);
      expect(distributedCache.getMany).toHaveResolvedTimes(0);

      // Memory cache should still be stale, because it was not updated
      await expectCacheEntriesStale(keys, memoryCache);
    });

    it("waits when distributed cache soft timeout occurs without stale data", async () => {
      // Make memory cache expire so it does not have anything stale
      await advanceSeconds(lifetimeM);

      // Mock distributed cache to be slow (exceeds soft timeout)
      distributedCache.getMany = vitest.fn().mockImplementation((k) => delayedGetMany(k, timeoutSoftD + 0.1));

      const action = sut.getBatch(keys);

      await advanceSeconds(timeoutSoftD);

      // We should still be waiting
      expect(distributedCache.getMany).toHaveResolvedTimes(0);

      await advanceSeconds(0.1);

      const results = await action;

      // Should return stale data from memory cache instead of waiting for distributed cache
      expect(results).toMatchObject(inputBatch);
      expect(distributedCache.getMany).toHaveBeenCalledWith(keys);
      expect(distributedCache.getMany).toHaveResolvedTimes(1);

      // Memory cache should still be stale, because it was not updated
      await expectCacheEntriesFresh(keys, memoryCache);
    });

    it("updates cache in the background with values after soft timeout", async () => {
      // Make memory cache stale so it needs to check distributed cache
      await vitest.advanceTimersByTimeAsync(ttlM_ms);
      await expectCacheEntriesStale(keys, memoryCache);

      // Mock distributed cache to be slow (exceeds soft timeout)
      const extraTime = 0.1;
      distributedCache.getMany = vitest.fn().mockImplementation((k) => delayedGetMany(k, timeoutSoftD + extraTime));

      const action = sut.getBatch(keys);

      await advanceSeconds(timeoutSoftD);

      const results = await action;

      // Should return stale data from memory cache instead of waiting for distributed cache
      expect(results).toMatchObject(inputBatch);

      // Memory cache should still be stale, because it was not updated
      await expectCacheEntriesStale(keys, memoryCache);
      expect(distributedCache.getMany).toHaveResolvedTimes(0);

      // Wait the extra time
      await advanceSeconds(extraTime);

      expect(distributedCache.getMany).toHaveResolvedTimes(1);
      await expectCacheEntriesFresh(keys, memoryCache);
    });

    it("throws when distributed cache strict timeout occurs without stale data", async () => {
      // Make memory cache expire so it does not have anything stale
      await advanceSeconds(lifetimeM);

      // Mock distributed cache to be slow (exceeds soft timeout)
      distributedCache.getMany = vitest.fn().mockImplementation((k) => delayedGetMany(k, timeoutStrictD + 0.1));

      const action = sut.getBatch(keys);

      await advanceSeconds(timeoutStrictD);

      // We should still be waiting
      expect(distributedCache.getMany).toHaveResolvedTimes(0);

      await advanceSeconds(0.1);

      await expect(action).rejects.toBe("strict timeout");

      // Memory cache should still be empty, because it was not updated
      await expectCacheEntriesDoNotExist(keys, memoryCache);
    });
  });

  describe("when factory times out", () => {
    const inputs: { [key: string]: Input } = {
      "#1": { name: "Case #1", count: 2, values: [true, false] },
      "#2": { name: "Case #2", count: 3, values: [false, true, false] },
    };

    const keys = Object.keys(inputs);
    const inputBatch = new Map(Object.entries(inputs));

    let delayedFactory: (keys: Key[], delay: Seconds) => Promise<Map<Key, Input>>;
    let originalFactory: (keys: Key[]) => Promise<Map<Key, Input>>;

    beforeEach(async () => {
      // Stale memory cache and clear distributed to force factory usage
      await sut.setBatch(inputBatch);
      await vitest.advanceTimersByTimeAsync(1);
      await advanceSeconds(ttlM);

      originalFactory = async (factoryKeys: Key[]) => {
        const result = new Map<Key, Input>();
        factoryKeys.forEach((k) => result.set(k, inputs[k]));
        return result;
      };
      delayedFactory = (ks, delay) =>
        new Promise((resolve) => setTimeout(resolve, delay * MS_IN_A_SEC)).then(() => originalFactory(ks));
    });

    it("returns stale distributed data when soft timeout occurs", async () => {
      // Expire distributed cache TTL so entries become stale
      await advanceSeconds(ttlD);

      // Mock factory to be slow (exceeds soft timeout)
      const factoryFn = vitest.fn().mockImplementation((ks) => delayedFactory(ks, timeoutSoftF + 0.1));
      const action = sut.getBatch(keys, factoryFn);

      // Advance to soft timeout
      await advanceSeconds(timeoutSoftF);

      // Should return stale distributed data
      const results = await action;
      expect(results).toMatchObject(inputBatch);
      expect(factoryFn).toHaveBeenCalledWith(keys);
      expect(factoryFn).toHaveResolvedTimes(0);

      // Memory cache should still reflect stale data
      await expectCacheEntriesStale(keys, memoryCache);
    });

    it("waits when soft timeout occurs without stale data", async () => {
      // Clear distributed cache to force missing keys and skip soft timeout
      await distributedCache.clear();

      // Mock factory to be slow (exceeds soft timeout)
      const factoryFn = vitest.fn().mockImplementation((ks) => delayedFactory(ks, timeoutSoftF + 0.1));
      const action = sut.getBatch(keys, factoryFn);

      // Advance to soft timeout
      await advanceSeconds(timeoutSoftF);
      // Should still be waiting because skipSoftTimeout=true
      expect(factoryFn).toHaveResolvedTimes(0);

      // Advance a bit more to complete factory
      await advanceSeconds(0.1);
      const results = await action;

      expect(results).toMatchObject(inputBatch);
      expect(factoryFn).toHaveBeenCalledWith(keys);

      // Memory cache should have been updated with fresh entries
      await expectCacheEntriesFresh(keys, memoryCache);
    });

    it("updates cache in the background with values after soft timeout", async () => {
      // Expire distributed cache TTL so entries become stale
      await advanceSeconds(ttlD);

      const extraTime = 0.1;
      // Mock factory to be slow by extraTime
      const factoryFn = vitest.fn().mockImplementation((ks) => delayedFactory(ks, timeoutSoftF + extraTime));
      const action = sut.getBatch(keys, factoryFn);

      // Advance to soft timeout and get fallback stale data
      await advanceSeconds(timeoutSoftF);
      const results = await action;
      expect(results).toMatchObject(inputBatch);
      expect(factoryFn).toHaveResolvedTimes(0);

      // Memory stays stale initially
      await expectCacheEntriesStale(keys, memoryCache);

      // Wait extra time for factory to resolve and update cache in background
      await advanceSeconds(extraTime);
      expect(factoryFn).toHaveResolvedTimes(1);

      // Memory cache should now have fresh entries
      await expectCacheEntriesFresh(keys, memoryCache);
    });

    it("throws when factory strict timeout occurs without stale data in distributed cache", async () => {
      await distributedCache.clear();
      await advanceSeconds(lifetimeM - ttlM);

      const factoryFn = vitest.fn().mockImplementation((ks: Key[]) => delayedFactory(ks, timeoutStrictF + 0.1));
      const action = sut.getBatch(keys, factoryFn);

      await advanceSeconds(timeoutStrictF);
      await advanceSeconds(0.1);
      await expect(action).rejects.toBe("strict timeout");

      await expectCacheEntriesDoNotExist(keys, memoryCache);
    });
  });

  // Helper functions to reduce repetition
  async function expectCacheEntriesDoNotExist(keys: Key[], cache: Keyv) {
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

  function advanceSeconds(s: Seconds) {
    return vitest.advanceTimersByTimeAsync(s * MS_IN_A_SEC);
  }
});
