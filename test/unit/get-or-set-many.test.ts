import { describe, it, expect, vi, beforeEach } from "vitest";
import Keyv from "keyv";
import { TieredCacheLayer } from "../../src/CacheLayer";
import { CacheSettings } from "../../src/Types";

describe("getOrSetMany", () => {
  let cache: TieredCacheLayer;
  let memory: Keyv;
  let distributed: Keyv;
  let settings: CacheSettings;

  beforeEach(() => {
    memory = new Keyv();
    distributed = new Keyv();
    settings = {
      ttl: {
        memory: { soft: 30, strict: 60 },
        distributed: { soft: 300, strict: 600 },
      },
      timeouts: {
        soft: 50,
        strict: 100,
      },
      allowBackgroundUpdates: true,
    };
    cache = new TieredCacheLayer(settings, memory, distributed);
  });

  it("should return cached values if available and not expired", async () => {
    const factory = vi.fn().mockResolvedValue(["fresh-1", "fresh-2"]);

    // Pre-populate cache
    await cache.setMany([
      { key: "key1", value: "cached-1" },
      { key: "key2", value: "cached-2" },
    ]);

    const result = await cache.getOrSetMany(["key1", "key2"], factory);

    expect(result).toEqual(["cached-1", "cached-2"]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("should call factory for missing keys only", async () => {
    const factory = vi.fn().mockResolvedValue(["factory-2"]);

    // Pre-populate cache with one key
    await cache.set({ key: "key1", value: "cached-1" });

    const result = await cache.getOrSetMany(["key1", "key2"], factory);

    expect(result).toEqual(["cached-1", "factory-2"]);
    expect(factory).toHaveBeenCalledWith(["key2"]);
  });

  it("should call factory if all keys are missing", async () => {
    const factory = vi.fn().mockResolvedValue(["factory-1", "factory-2"]);

    const result = await cache.getOrSetMany(["key1", "key2"], factory);

    expect(result).toEqual(["factory-1", "factory-2"]);
    expect(factory).toHaveBeenCalledWith(["key1", "key2"]);
  });

  it("should handle soft timeout by returning stale values", async () => {
    const factory = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(["slow-1", "slow-2"]), 100)));

    // Pre-populate with expired values
    await cache.setMany([
      { key: "key1", value: "stale-1", expired: true },
      { key: "key2", value: "stale-2", expired: true },
    ]);

    const result = await cache.getOrSetMany(["key1", "key2"], factory);

    expect(result).toEqual(["stale-1", "stale-2"]);
  });

  it("should handle hard timeout by throwing error", async () => {
    const factory = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(["slow-1", "slow-2"]), 200)));

    await expect(cache.getOrSetMany(["key1", "key2"], factory)).rejects.toThrow("Hard timeout exceeded");
  });

  it("should provide stampede protection for batch operations", async () => {
    const factory = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(["factory-1", "factory-2"]), 50)));

    // Start multiple concurrent requests
    const promises = Array.from({ length: 3 }, () => cache.getOrSetMany(["key1", "key2"], factory));

    const results = await Promise.all(promises);

    // All should return the same values
    expect(results).toEqual([
      ["factory-1", "factory-2"],
      ["factory-1", "factory-2"],
      ["factory-1", "factory-2"],
    ]);
    // Factory should only be called once due to stampede protection
    expect(factory).toHaveBeenCalledOnce();
  });

  it("should handle mixed fresh/stale/missing keys", async () => {
    const factory = vi.fn().mockResolvedValue(["factory-2", "factory-3"]);

    // Pre-populate with fresh and stale values
    await cache.set({ key: "key1", value: "fresh-1" });
    await cache.set({ key: "key2", value: "stale-2", expired: true });

    const result = await cache.getOrSetMany(["key1", "key2", "key3"], factory);

    expect(result).toEqual(["fresh-1", "factory-2", "factory-3"]);
    expect(factory).toHaveBeenCalledWith(["key2", "key3"]);
  });

  it("should cache results from factory", async () => {
    const factory = vi.fn().mockResolvedValue(["factory-1", "factory-2"]);

    // First call should invoke factory
    const result1 = await cache.getOrSetMany(["key1", "key2"], factory);
    expect(result1).toEqual(["factory-1", "factory-2"]);
    expect(factory).toHaveBeenCalledOnce();

    // Second call should use cached values
    const result2 = await cache.getOrSetMany(["key1", "key2"], factory);
    expect(result2).toEqual(["factory-1", "factory-2"]);
    expect(factory).toHaveBeenCalledOnce(); // Still only called once
  });

  it("should handle partial timeouts with mixed stale/fresh data", async () => {
    const factory = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(["slow-2"]), 100)));

    // Pre-populate one key with fresh data, one with stale
    await cache.set({ key: "key1", value: "fresh-1" });
    await cache.set({ key: "key2", value: "stale-2", expired: true });

    const result = await cache.getOrSetMany(["key1", "key2"], factory);

    // Should return fresh value for key1, stale value for key2 (due to timeout)
    expect(result).toEqual(["fresh-1", "stale-2"]);
  });
});
