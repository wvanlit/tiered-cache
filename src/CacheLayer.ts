import Keyv from "keyv";
import { CacheLayer, CacheSettings, Cacheable, CacheItem, InternalCacheItem } from "./Types";

const MS_IN_A_SEC = 1000;

export class TieredCacheLayer implements CacheLayer {
  private readonly settings: CacheSettings;
  private readonly memory: Keyv;
  private readonly distributed: Keyv;

  constructor(settings: CacheSettings, memory: Keyv, distributed: Keyv) {
    this.settings = settings;
    this.memory = memory;
    this.distributed = distributed;
  }

  async get<T extends Cacheable>(key: string, allowExpired: boolean): Promise<T | null> {
    const [memoryItem, memoryExpired] = await this.getFromCache<T>(this.memory, key);
    if (memoryItem && !memoryExpired) {
      return memoryItem;
    }

    const [distributedItem, distributedExpired] = await this.getFromCache<T>(this.distributed, key);
    if (distributedItem && (!distributedExpired || allowExpired)) {
      return distributedItem;
    }

    if (allowExpired && distributedExpired && memoryItem) {
      return memoryItem;
    }

    return null;
  }

  async set<T extends Cacheable>(item: CacheItem<T>): Promise<void> {
    await Promise.allSettled([this.setInCache(this.memory, item), this.setInCache(this.distributed, item)]);
  }

  getMany<T extends Cacheable>(...keys: string[]): Promise<(T | null)[]> {
    throw new Error("Method not implemented.");
  }
  setMany<T extends Cacheable>(...items: CacheItem<T>[]): Promise<void> {
    throw new Error("Method not implemented.");
  }
  getOrSet<T extends Cacheable>(key: string, factory: () => Promise<T>): Promise<T> {
    throw new Error("Method not implemented.");
  }
  getOrSetMany<T extends Cacheable>(keys: string[], factory: (missing: string[]) => Promise<T[]>): Promise<T[]> {
    throw new Error("Method not implemented.");
  }

  private setInCache<T extends Cacheable>(cache: Keyv, item: CacheItem<T>) {
    const isMemory = cache === this.memory;
    const setting = isMemory ? this.settings.ttl.memory : this.settings.ttl.distributed;

    return cache.set<InternalCacheItem<T>>(
      item.key,
      { value: item.value, expiredAfter: this.now() + setting.soft * MS_IN_A_SEC },
      setting.strict * MS_IN_A_SEC,
    );
  }

  private now() {
    return Date.now();
  }

  private async getFromCache<T extends Cacheable>(cache: Keyv, key: string): Promise<[T | null, boolean]> {
    const memoryItem = await cache.get<InternalCacheItem<T>>(key);

    let expired = true;
    if (memoryItem) {
      expired = memoryItem.expiredAfter < this.now();
    }

    return [memoryItem?.value ?? null, expired] as const;
  }
}
