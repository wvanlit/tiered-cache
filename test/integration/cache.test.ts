import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Keyv from "keyv";
import KeyvRedis from "@keyv/redis";

const redisURI = "redis://localhost:6379";
const cache = new Keyv({ store: new KeyvRedis(redisURI) });

beforeAll(async () => {
  // Ensure Redis is ready and clear any existing data
  await cache.clear();
});

afterAll(async () => {
  // Disconnect Redis client
  const store: any = cache.store;
  if (store && store.redis) {
    await store.redis.quit();
  }
});

describe.skip("Redis Integration Tests", () => {
  it("should set and get a value from Redis", async () => {
    await cache.set("test_key", "test_value", 5);
    const value = await cache.get("test_key");
    expect(value).toBe("test_value");
  });

  it("should expire items after TTL", async () => {
    await cache.set("expiring_key", "value", 1); // TTL 1 second
    const immediate = await cache.get("expiring_key");
    expect(immediate).toBe("value");
    // wait for expiration
    await new Promise((r) => setTimeout(r, 1100));
    const expired = await cache.get("expiring_key");
    expect(expired).toBeUndefined();
  });
});
