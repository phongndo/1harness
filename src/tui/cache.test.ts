import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoundedMap, FetchCache } from "./cache.ts";

describe("BoundedMap", () => {
  it("forgets the entry set longest ago once it holds more than its limit", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1).set("b", 2);
    // Set again, `a` is the newest.
    map.set("a", 3);
    map.set("c", 4);
    assert.deepEqual(
      [...map],
      [
        ["a", 3],
        ["c", 4],
      ],
    );
  });
});

describe("FetchCache", () => {
  it("fetches a value once, gives nothing until it is in, then says it arrived", async () => {
    const arrived: string[] = [];
    const cache = new FetchCache<string, string>({ arrived: (value) => arrived.push(value) });
    let fetches = 0;
    const fetch = async () => `value ${++fetches}`;
    assert.equal(cache.get("a", fetch), undefined);
    assert.equal(cache.get("a", fetch), undefined, "fetched once");
    assert.equal(await cache.load("a", fetch), "value 1");
    assert.equal(cache.get("a", fetch), "value 1");
    assert.deepEqual(arrived, ["value 1"]);
    assert.equal(fetches, 1);
  });

  it("drops a value forgotten while it was fetched, and fetches a failed one again", async () => {
    const arrived: string[] = [];
    const cache = new FetchCache<string, string>({ arrived: (value) => arrived.push(value) });
    const loading = cache.load("a", async () => "stale");
    cache.clear();
    assert.equal(await loading, "stale", "whoever waited still gets it");
    assert.equal(cache.has("a"), false);
    assert.deepEqual(arrived, []);
    await assert.rejects(
      cache.load("b", async () => {
        throw new Error("down");
      }),
    );
    assert.equal(
      cache.get("b", async () => "back"),
      undefined,
    );
    assert.equal(await cache.load("b", async () => "unused"), "back");
  });

  it("keeps at most its limit", async () => {
    const cache = new FetchCache<string, number>({ limit: 1 });
    await cache.load("a", async () => 1);
    await cache.load("b", async () => 2);
    assert.equal(cache.peek("a"), undefined);
    assert.equal(cache.peek("b"), 2);
  });
});
