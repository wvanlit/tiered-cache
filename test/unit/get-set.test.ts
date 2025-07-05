import Keyv from "keyv";
import { describe, it, expect, vitest, beforeEach, beforeAll, afterAll } from "vitest";
import { TieredCacheLayer } from "../../src/CacheLayer";
import { CacheLayer } from "../../src/Types";

describe("TieredCacheLayer get/set tests", () => {
  beforeAll(() => vitest.useFakeTimers());
  afterAll(() => vitest.useRealTimers());

  let sut: CacheLayer;
  let memoryCache: Keyv;
  let distributedCache: Keyv;

  const memorySoftTtl = 1;
  const memoryStrictTtl = 2;
  const distributedSoftTtl = 5;
  const distributedStrictTtl = 10;

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

  const key = "test";
  const input = Object.freeze({
    x: new Date().toString(),
    y: 12,
    z: "hello",
  });

  it("can read and write the same value from both caches", async () => {
    await sut.set({ key, value: input });

    const output = await sut.get<typeof input>(key, false);

    expect(output).toMatchObject(input);
  });

  it("falls back to memory cache when not in distributed cache", async () => {
    await sut.set({ key, value: input });
    await distributedCache.clear();

    const output = await sut.get<typeof input>(key, false);

    expect(output).toMatchObject(input);
  });

  it("will expire entry after strict ttl passed", async () => {
    await sut.set({ key, value: input });

    vitest.advanceTimersByTime(1); // To prevent off-by-one
    vitest.advanceTimersByTime(memoryStrictTtl * 1000);

    const memoryExpired = await sut.get<typeof input>(key, false);
    const inMemory = await memoryCache.get(key);

    expect(memoryExpired).toMatchObject(input);
    expect(inMemory).toBeUndefined();

    vitest.advanceTimersByTime((distributedStrictTtl - memoryStrictTtl) * 1000);

    const after = await sut.get<typeof input>(key, false);
    const inDistributed = await distributedCache.get(key);

    expect(after).toBeNull();
    expect(inDistributed).toBeUndefined();
  });

  it("will soft expire entry after soft ttl passes", async () => {
    await sut.set({ key, value: input });

    vitest.advanceTimersByTime(1); // To prevent off-by-one
    vitest.advanceTimersByTime(distributedSoftTtl * 1000);

    const noExpiredAllowed = await sut.get<typeof input>(key, false);
    const expiredAllowed = await sut.get<typeof input>(key, true);

    expect(noExpiredAllowed).toBeNull();
    expect(expiredAllowed).toMatchObject(input);
  });

  it("will fall back to memory if distributed is empty", async () => {
    await sut.set({ key, value: input });
    await distributedCache.clear();

    const output = await sut.get<typeof input>(key, false);

    expect(output).toMatchObject(input);
  });

  it("will fall back to expired memory if distributed is empty", async () => {
    await sut.set({ key, value: input });
    await distributedCache.clear();

    const output = await sut.get<typeof input>(key, false);

    expect(output).toMatchObject(input);

    vitest.advanceTimersByTime(1); // To prevent off-by-one
    vitest.advanceTimersByTime(memorySoftTtl * 1000);

    const noExpiredAllowed = await sut.get<typeof input>(key, false);
    const expiredAllowed = await sut.get<typeof input>(key, true);

    expect(noExpiredAllowed).toBeNull();
    expect(expiredAllowed).toMatchObject(input);
  });
});
