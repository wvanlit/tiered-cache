import Keyv from "keyv";

/**
 * Only JSON serialization compatible values
 */
export type Cacheable = string | number | boolean | null | undefined | Cacheable[] | { [key: string]: Cacheable };

export type Key = string;
export type Batch<T> = Map<Key, T>;

export interface Cache {
  get<T extends Cacheable>(key: Key): Promise<T>;
  get<T extends Cacheable>(key: Key, factory: () => Promise<T>): Promise<T>;

  getBatch<T extends Cacheable>(keys: Key[]): Promise<Batch<T>>;
  getBatch<T extends Cacheable>(keys: Key[], factory: (keys: Key[]) => Promise<Batch<T>>): Promise<Batch<T>>;

  set<T extends Cacheable>(key: Key, value: T): Promise<void>;
  setBatch<T extends Cacheable>(values: Batch<T>): Promise<void>;

  has(key: Key): Promise<boolean>;
  hasBatch(keys: Key[]): Promise<Batch<boolean>>;

  delete(key: Key): Promise<void>;
  deleteBatch(keys: Key[]): Promise<void>;

  clear(): Promise<void>;
}

export type Seconds = number;

/**
 * We use 2 types of timeouts.
 * A soft timeout returns stale data after it has been passed.
 * A strict timeout throws an exception after it has been passed.
 */
export type Timeout = {
  soft: Seconds;
  strict: Seconds;
};

export type CacheLayerConfiguration = {
  /**
   * The actual cache object
   */
  cache: Keyv;

  /**
   * Duration a cache entry is considered fresh — after this it becomes stale
   */
  ttl: Seconds;

  /**
   * Absolute duration a cache entry is allowed to stay in the cache — even when stale
   */
  lifetime: Seconds;
};

export type CacheConfiguration = {
  /**
   * The first tier of caching used
   */
  memory: CacheLayerConfiguration;

  /**
   * The second tier of caching
   */
  distributed: CacheLayerConfiguration;

  /**
   * Time out applied to getting data from the distributed cache
   */
  distributedTimeout: Timeout;

  /**
   * Time out applied to getting fresh data from a factory method
   */
  factoryTimeout: Timeout;
};

export default class MultiTieredCache implements Cache {
  get<T extends Cacheable>(key: Key, factory?: () => Promise<T>): Promise<T> | Promise<T> {
    throw new Error("Method not implemented.");
  }
  getBatch<T extends Cacheable>(keys: Key[], factory?: (keys: Key[]) => Promise<Batch<T>>): Promise<Batch<T>> {
    throw new Error("Method not implemented.");
  }

  set<T extends Cacheable>(key: Key, value: T): Promise<void> {
    throw new Error("Method not implemented.");
  }
  setBatch<T extends Cacheable>(values: Batch<T>): Promise<void> {
    throw new Error("Method not implemented.");
  }
  has(key: Key): Promise<boolean> {
    throw new Error("Method not implemented.");
  }
  hasBatch(keys: Key[]): Promise<Batch<boolean>> {
    throw new Error("Method not implemented.");
  }
  delete(key: Key): Promise<void> {
    throw new Error("Method not implemented.");
  }
  deleteBatch(keys: Key[]): Promise<void> {
    throw new Error("Method not implemented.");
  }
  clear(): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
