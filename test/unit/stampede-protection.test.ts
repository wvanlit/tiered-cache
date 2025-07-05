import Keyv from "keyv";
import { describe, it, expect, vitest, beforeEach, beforeAll, afterAll } from "vitest";
import { TieredCacheLayer } from "../../src/CacheLayer";
import { CacheLayer, InternalCacheItem } from "../../src/Types";

describe("TieredCacheLayer stampede protection tests", () => {
  beforeAll(() => vitest.useFakeTimers());
  afterAll(() => vitest.useRealTimers());

  let sut: CacheLayer;
  let memoryCache: Keyv;
  let distributedCache: Keyv;

  const memorySoftTtl = 1;
  const memoryStrictTtl = 2;
  const distributedSoftTtl = 5;
  const distributedStrictTtl = 10;

  const key = "test";
  const input = Object.freeze({
    x: new Date().toString(),
    y: 12,
    z: "hello",
  });

  beforeEach(() => {
    memoryCache = new Keyv();
    // We're "mocking" the distributed cache using a memory cache
    distributedCache = new Keyv();

    sut = new TieredCacheLayer(
      {
        timeouts: {
          soft: 100,
          strict: 200,
        },
        ttl: {
          memory: {
            soft: memorySoftTtl,
            strict: memoryStrictTtl,
          },
          distributed: {
            soft: distributedSoftTtl,
            strict: distributedStrictTtl,
          },
        },
      },
      memoryCache,
      distributedCache,
    );
  });

  it("protects the distributed cache from getting called multiple times for the same key in parallel", async () => {
    await sut.set({ key, value: input });
    await memoryCache.clear();

    let resolveLazy!: (item: InternalCacheItem<typeof input>) => void;
    const lazyGet = new Promise<InternalCacheItem<typeof input>>((res) => (resolveLazy = res));
    const getSpy = vitest.spyOn(distributedCache, "get").mockImplementation(() => lazyGet as any);

    // Parallel requests should cause "race condition"
    const p1 = sut.get<typeof input>(key, false);
    const p2 = sut.get<typeof input>(key, false);
    const p3 = sut.get<typeof input>(key, false);

    resolveLazy({ value: input, expiredAfter: Date.now() + distributedSoftTtl * 1000 });

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toMatchObject([input, input, input]);

    expect(getSpy).toHaveBeenCalledTimes(1);

    await memoryCache.clear();
  });

  it("returns expired memory cache items when already fetching from distributed on a different request", async () => {
    await sut.set({ key, value: input });

    vitest.advanceTimersByTime(1); // To prevent off-by-one
    vitest.advanceTimersByTime(memorySoftTtl * 1000);

    let resolveLazy!: (item: InternalCacheItem<typeof input>) => void;
    const lazyGet = new Promise<InternalCacheItem<typeof input>>((res) => (resolveLazy = res));
    const getSpy = vitest.spyOn(distributedCache, "get").mockImplementation(() => lazyGet as any);

    const p1 = sut.get<typeof input>(key, true);

    vitest.advanceTimersByTime(1);

    const p2 = sut.get<typeof input>(key, true);
    const p3 = sut.get<typeof input>(key, true);

    // p2 & p3 should resolve before p1 is done
    expect(await p2).toMatchObject(input);
    expect(await p3).toMatchObject(input);

    // p1 should not yet have been resolved
    resolveLazy({ value: input, expiredAfter: Date.now() + distributedSoftTtl * 1000 });

    expect(await p1).toMatchObject(input);
  });
});
