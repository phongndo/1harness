/**
 * A map of at most `limit` entries, forgetting the one set longest ago: for
 * what the terminal draws or fetches and can draw or fetch again, which a
 * long session would otherwise keep every size and theme of.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  readonly #limit: number;

  constructor(limit: number) {
    super();
    this.#limit = limit;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.#limit) super.delete(this.keys().next().value!);
    return this;
  }
}

type Slot<V> = { value: V } | { pending: Promise<V> };

/**
 * Values fetched on first asking and kept, for what the terminal shows once
 * it comes: `get` starts the fetch and gives nothing until the value is in,
 * when `arrived` is told, to show it. A value forgotten while it is fetched
 * is dropped when it comes. One whose fetch fails is fetched again when next
 * asked for, so a fetch not worth trying again settles on a value instead.
 */
export class FetchCache<K, V> {
  #slots: Map<K, Slot<V>>;
  #arrived: (value: V, key: K) => void;

  /** `limit` keeps at most that many, as a BoundedMap does. */
  constructor(options: { limit?: number; arrived?: (value: V, key: K) => void } = {}) {
    this.#slots = options.limit === undefined ? new Map() : new BoundedMap(options.limit);
    this.#arrived = options.arrived ?? (() => {});
  }

  /** The value, or undefined while it is fetched, which asking for it first starts. */
  get(key: K, fetch: () => Promise<V>): V | undefined {
    const slot = this.#slots.get(key);
    if (slot && "value" in slot) return slot.value;
    if (!slot) this.load(key, fetch).catch(() => {});
    return undefined;
  }

  /** The value once it is in, fetching it on first asking. */
  load(key: K, fetch: () => Promise<V>): Promise<V> {
    const slot = this.#slots.get(key);
    if (slot) return "value" in slot ? Promise.resolve(slot.value) : slot.pending;
    const pending: Slot<V> = {
      pending: new Promise<V>((resolve) => resolve(fetch())).then(
        (value) => {
          if (this.#slots.get(key) === pending) {
            this.#slots.set(key, { value });
            this.#arrived(value, key);
          }
          return value;
        },
        (error: unknown) => {
          if (this.#slots.get(key) === pending) this.#slots.delete(key);
          throw error;
        },
      ),
    };
    this.#slots.set(key, pending);
    return pending.pending;
  }

  /** The value, where it is in, without fetching it. */
  peek(key: K): V | undefined {
    const slot = this.#slots.get(key);
    return slot && "value" in slot ? slot.value : undefined;
  }

  /** Whether the value is in or being fetched. */
  has(key: K): boolean {
    return this.#slots.has(key);
  }

  delete(key: K): void {
    this.#slots.delete(key);
  }

  clear(): void {
    this.#slots.clear();
  }
}
