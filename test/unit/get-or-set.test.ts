import { describe, it, expect, vi, beforeEach } from "vitest";
import Keyv from "keyv";
import { TieredCacheLayer } from "../../src/CacheLayer";
import { CacheSettings } from "../../src/Types";

describe("getOrSet", () => {
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
        distributed: { soft: 300, strict: 600 }
      },
      timeouts: {
        soft: 50,
        strict: 100
      },
      allowBackgroundUpdates: true
    };
    cache = new TieredCacheLayer(settings, memory, distributed);
  });

  it("should return cached value if available and not expired", async () => {
    const factory = vi.fn().mockResolvedValue("fresh-value");
    
    // Pre-populate cache
    await cache.set({ key: "test-key", value: "cached-value" });
    
    const result = await cache.getOrSet("test-key", factory);
    
    expect(result).toBe("cached-value");
    expect(factory).not.toHaveBeenCalled();
  });

  it("should call factory if cache is empty", async () => {
    const factory = vi.fn().mockResolvedValue("factory-value");
    
    const result = await cache.getOrSet("test-key", factory);
    
    expect(result).toBe("factory-value");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("should handle soft timeout by returning stale value", async () => {
    const factory = vi.fn().mockImplementation(() => 
      new Promise(resolve => setTimeout(() => resolve("slow-value"), 100))
    );
    
    // Pre-populate with expired value
    await cache.set({ key: "test-key", value: "stale-value", expired: true });
    
    const result = await cache.getOrSet("test-key", factory);
    
    expect(result).toBe("stale-value");
  });

  it("should handle hard timeout by throwing error", async () => {
    const factory = vi.fn().mockImplementation(() => 
      new Promise(resolve => setTimeout(() => resolve("slow-value"), 200))
    );
    
    await expect(cache.getOrSet("test-key", factory)).rejects.toThrow("Hard timeout exceeded");
  });

  it("should provide stampede protection", async () => {
    const factory = vi.fn().mockImplementation(() => 
      new Promise(resolve => setTimeout(() => resolve("factory-value"), 50))
    );
    
    // Start multiple concurrent requests
    const promises = Array.from({ length: 5 }, () => cache.getOrSet("test-key", factory));
    
    const results = await Promise.all(promises);
    
    // All should return the same value
    expect(results).toEqual(["factory-value", "factory-value", "factory-value", "factory-value", "factory-value"]);
    // Factory should only be called once due to stampede protection
    expect(factory).toHaveBeenCalledOnce();
  });
});
