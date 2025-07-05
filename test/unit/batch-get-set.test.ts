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

    const outputs = await sut.getMany<Input>(keys);

    expect(outputs).toMatchObject(inputs);
  });

  it("uses memory cache when not in distributed cache", async () => {
    await sut.setMany(items);
    await distributedCache.clear();

    const output = await sut.getMany<Input>(keys);

    expect(output).toMatchObject(inputs);
  });

  it("uses distributed cache when not in memory cache", async () => {
    await sut.setMany(items);
    await memoryCache.clear();

    const output = await sut.getMany<Input>(keys);

    expect(output).toMatchObject(inputs);
  });

  it.each([[{ memory: [1, 2], distributed: [3] }], [{ memory: [1], distributed: [2, 3] }]])(
    "handles partials",
    async (data) => {
      await sut.setMany(items);

      await memoryCache.deleteMany(keys.filter((_, i) => !data.memory.includes(i + 1)));
      await distributedCache.deleteMany(keys.filter((_, i) => !data.distributed.includes(i + 1)));

      const output = await sut.getMany<Input>(keys);

      expect(output).toMatchObject(inputs);
    },
  );
});
