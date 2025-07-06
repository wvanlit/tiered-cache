/**
 * Only JSON serialization compatible values
 */
export type Cacheable = string | number | boolean | null | undefined | Cacheable[] | { [key: string]: Cacheable };

export type Key = string;
export type Batch<T> = Map<Key, T>;

export interface Cache {
  get<T extends Cacheable>(key: Key): Promise<T>;
  get<T extends Cacheable>(key: Key, factory: () => Promise<T>): Promise<T>;

  get<T extends Cacheable>(keys: Key[]): Promise<Batch<T>>;
  get<T extends Cacheable>(keys: Key[], factory: (keys: Key[]) => Promise<Batch<T>>): Promise<Batch<T>>;

  set<T extends Cacheable>(key: Key, value: T): Promise<void>;
  set<T extends Cacheable>(values: Batch<T>): Promise<void>;

  has(key: Key): Promise<boolean>;
  has(keys: Key[]): Promise<Batch<boolean>>;

  delete(key: Key): Promise<void>;
  delete(keys: Key[]): Promise<void>;

  clear(): Promise<void>;
}
