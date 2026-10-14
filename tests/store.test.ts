import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStore, redisStore } from "../src/server/store";
import type { StoredCharge } from "../src/server/store";

export const record = (): StoredCharge => ({
  id: "challenge-id",
  serializedChallenge: "challenge",
  paymentHash: "a".repeat(64),
  amountSat: 100,
  expiresAt: Date.now() + 60_000,
  requestUrl: "https://example.test/paid",
  requestMethod: "GET",
  bodyHash: "b".repeat(64),
});

afterEach(() => vi.restoreAllMocks());

describe("memory store", () => {
  it("allows one concurrent consume and prevents invoice and ID reuse", async () => {
    const store = memoryStore();
    const charge = record();

    await store.issue(charge);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.consume(charge.id)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(store.issue({ ...charge, id: "another-id" })).rejects.toThrow(
      "already issued",
    );
    await expect(
      store.issue({ ...charge, paymentHash: "b".repeat(64) }),
    ).rejects.toThrow("already issued");
  });

  it("rejects expired and unknown challenges and prunes old data", async () => {
    const store = memoryStore();
    const charge = record();

    await store.issue(charge);
    vi.spyOn(Date, "now").mockReturnValue(charge.expiresAt);
    expect(await store.consume(charge.id)).toBe(false);
    expect(await store.consume("unknown")).toBe(false);
    expect(await store.pruneExpired()).toBe(1);
    expect(await store.get(charge.id)).toBeUndefined();
    await expect(store.issue(charge)).rejects.toThrow("expired");
  });

  it("caps memory use without evicting active challenges", async () => {
    const store = memoryStore({ maxEntries: 1 });
    const charge = record();

    await store.issue(charge);
    await expect(
      store.issue({ ...charge, id: "second", paymentHash: "b".repeat(64) }),
    ).rejects.toThrow("capacity");
    expect(await store.consume(charge.id)).toBe(true);
  });

  it("stores immutable snapshots", async () => {
    const store = memoryStore();
    const charge = record();

    await store.issue(charge);

    const snapshot = await store.get(charge.id);

    Object.assign(charge, { amountSat: 1 });
    Object.assign(snapshot!, { amountSat: 2 });
    expect((await store.get(charge.id))!.amountSat).toBe(100);
  });
});

describe("Redis store failures", () => {
  it("propagates connection errors without accepting a payment", async () => {
    const client = {
      sendCommand: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
    };
    const store = redisStore(client);

    await expect(store.issue(record())).rejects.toThrow("Redis unavailable");
    await expect(store.get("challenge-id")).rejects.toThrow(
      "Redis unavailable",
    );
    await expect(store.consume("challenge-id")).rejects.toThrow(
      "Redis unavailable",
    );
  });

  it("fails closed on unexpected command replies", async () => {
    const store = redisStore({ sendCommand: async () => "OK" });

    await expect(store.issue(record())).rejects.toThrow(
      "Unexpected Redis issuance response",
    );
    await expect(store.consume("challenge-id")).rejects.toThrow(
      "Unexpected Redis consumption response",
    );
  });

  it.each([
    JSON.stringify({ ...record(), id: "other" }),
    JSON.stringify({ ...record(), paymentHash: "invalid" }),
    "invalid-json",
    "{}",
  ])("rejects corrupt records", async (value) => {
    const store = redisStore({ sendCommand: async () => value });

    await expect(store.get("challenge-id")).rejects.toThrow();
  });

  it("rejects invalid IDs and prefixes before contacting Redis", async () => {
    const client = { sendCommand: vi.fn() };
    const store = redisStore(client);

    expect(await store.get("../outside")).toBeUndefined();
    expect(await store.consume("../outside")).toBe(false);
    await expect(
      store.issue({ ...record(), id: "../outside" }),
    ).rejects.toThrow();
    expect(client.sendCommand).not.toHaveBeenCalled();
    expect(() => redisStore(client, { keyPrefix: "bad{tag}" })).toThrow(
      "keyPrefix",
    );
  });
});
