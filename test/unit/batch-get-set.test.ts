import Keyv from "keyv";
import { describe, it, expect, vitest, beforeEach, beforeAll, afterAll } from "vitest";
import { TieredCacheLayer } from "../../src/CacheLayer";
import { CacheLayer, InternalCacheItem } from "../../src/Types";

describe("TieredCacheLayer batch get/set tests", () => {
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

  type Input = { x: number; y: string };

  const keys = ["#1", "#2", "#3"];
  const inputs: Input[] = [
    { x: 1, y: "1" },
    { x: 2, y: "2" },
    { x: 3, y: "3" },
  ];
  const items = inputs.map((v, i) => ({ value: v, key: keys[i] }));

  it("gets and sets full batches", async () => {
    await sut.setMany(items);

    const outputs = await sut.getMany<Input>(keys, false);

    expect(outputs).toMatchObject(inputs);
  });

  it("uses memory cache when not in distributed cache", async () => {
    await sut.setMany(items);
    await distributedCache.clear();

    const output = await sut.getMany<Input>(keys, false);

    expect(output).toMatchObject(inputs);
  });

  it("uses distributed cache when not in memory cache", async () => {
    await sut.setMany(items);
    await memoryCache.clear();

    const output = await sut.getMany<Input>(keys, false);

    expect(output).toMatchObject(inputs);
  });

  it.each([[{ memory: [1, 2], distributed: [3] }], [{ memory: [1], distributed: [2, 3] }]])(
    "handles partials",
    async (data) => {
      await sut.setMany(items);

      await memoryCache.deleteMany(keys.filter((_, i) => !data.memory.includes(i + 1)));
      await distributedCache.deleteMany(keys.filter((_, i) => !data.distributed.includes(i + 1)));

      const output = await sut.getMany<Input>(keys, false);

      expect(output).toMatchObject(inputs);
    },
  );

  it("puts items in memory cache when only in distributed cache", async () => {
    await sut.setMany(items);
    await memoryCache.clear();

    const outputs = await sut.getMany<Input>(keys, false);
    expect(outputs).toMatchObject(inputs);
  });

  it("puts items as expired in memory cache when items only in distributed cache as expired", async () => {
    await sut.setMany(items);
    await memoryCache.clear();

    vitest.advanceTimersByTime(1);
    vitest.advanceTimersByTime((distributedStrictTtl - memoryStrictTtl) * 1000);

    const outputs = await sut.getMany<Input>(keys, true);
    expect(outputs).toMatchObject(inputs);
  });

  it("will expire entries after strict ttl passed", async () => {
    await sut.setMany(items);

    vitest.advanceTimersByTime(1);
    vitest.advanceTimersByTime(memoryStrictTtl * 1000);

    for (const key of keys) {
      const inMem = await memoryCache.get(key);
      expect(inMem).toBeUndefined();
    }

    const fresh = await sut.getMany<Input>(keys, false);
    expect(fresh).toMatchObject(inputs);

    vitest.advanceTimersByTime((distributedStrictTtl - memoryStrictTtl) * 1000);

    const expired = await sut.getMany<Input>(keys, true);
    expect(expired).toEqual([null, null, null]);

    for (const key of keys) {
      const inDist = await distributedCache.get(key);
      expect(inDist).toBeUndefined();
    }
  });

  it("will soft expire entries after soft ttl passes", async () => {
    await sut.setMany(items);

    vitest.advanceTimersByTime(1);
    vitest.advanceTimersByTime(distributedSoftTtl * 1000);

    const noExpired = await sut.getMany<Input>(keys, false);
    const withExpired = await sut.getMany<Input>(keys, true);

    expect(noExpired).toEqual([null, null, null]);
    expect(withExpired).toMatchObject(inputs);
  });

  it("will fall back to memory if distributed is empty", async () => {
    await sut.setMany(items);
    await distributedCache.clear();

    const outputs = await sut.getMany<Input>(keys, false);
    expect(outputs).toMatchObject(inputs);
  });

  it("will fall back to expired memory if distributed is empty", async () => {
    await sut.setMany(items);
    await distributedCache.clear();

    const initial = await sut.getMany<Input>(keys, false);
    expect(initial).toMatchObject(inputs);

    vitest.advanceTimersByTime(1);
    vitest.advanceTimersByTime(memorySoftTtl * 1000);

    const noExpired = await sut.getMany<Input>(keys, false);
    const withExpired = await sut.getMany<Input>(keys, true);

    expect(noExpired).toEqual([null, null, null]);
    expect(withExpired).toMatchObject(inputs);
  });
});
