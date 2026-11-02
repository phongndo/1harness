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
