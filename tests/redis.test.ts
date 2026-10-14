import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { redisStore } from "../src/server";
import type { StoredCharge } from "../src/server";
import { redisFixture } from "./redis-fixture";
import { paidHttpFlow } from "./http-flow";

let redis: Awaited<ReturnType<typeof redisFixture>>;

beforeAll(async () => {
  redis = await redisFixture();
});

afterAll(async () => {
  await redis?.close();
});

const record = (): StoredCharge => ({
  id: "challenge-id",
  serializedChallenge: "challenge",
  paymentHash: "a".repeat(64),
  amountSat: 100,
  expiresAt: Date.now() + 60_000,
  requestUrl: "https://example.test/paid",
  requestMethod: "GET",
  bodyHash: "b".repeat(64),
});

const namespace = () => `test-${randomUUID()}`;

it("has exactly one winner across independent Redis store instances", async () => {
  const keyPrefix = namespace();
  const charge = record();

  await redisStore(redis.client(), { keyPrefix }).issue(charge);

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      redisStore(redis.client(), { keyPrefix }).consume(charge.id),
    ),
  );

  expect(results.filter(Boolean)).toHaveLength(1);
  expect(
    await redisStore(redis.client(), { keyPrefix }).get(charge.id),
  ).toEqual(charge);
});

it("atomically prevents duplicate invoice issuance", async () => {
  const keyPrefix = namespace();
  const charge = record();
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      redisStore(redis.client(), { keyPrefix }).issue({
        ...charge,
        id: `id-${i}`,
      }),
    ),
  );

  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
});

it("rejects reused IDs without reserving a different invoice", async () => {
  const store = redisStore(redis.client(), { keyPrefix: namespace() });
  const charge = record();

  await store.issue(charge);

  const different = { ...charge, paymentHash: "c".repeat(64) };

  await expect(store.issue(different)).rejects.toThrow("already issued");
  await store.issue({ ...different, id: "different-id" });
});

it("preserves outstanding and consumed challenges across Redis restarts", async () => {
  const keyPrefix = namespace();
  const store = redisStore(redis.client(), { keyPrefix });
  const charge = record();

  await store.issue(charge);
  await redis.restart();
  expect(
    await redisStore(redis.client(), { keyPrefix }).get(charge.id),
  ).toEqual(charge);
  expect(await store.consume(charge.id)).toBe(true);
  await redis.restart();
  expect(
    await redisStore(redis.client(), { keyPrefix }).consume(charge.id),
  ).toBe(false);
});

it("expires challenge and invoice reservation together without cleanup jobs", async () => {
  const keyPrefix = namespace();
  const store = redisStore(redis.client(), { keyPrefix });
  const charge = { ...record(), expiresAt: Date.now() + 500 };

  await store.issue(charge);

  const ttl = await redis
    .client()
    .sendCommand(["PTTL", `{${keyPrefix}}:challenge:${charge.id}`]);

  expect(Number(ttl)).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(await store.get(charge.id)).toBeUndefined();
  expect(await store.consume(charge.id)).toBe(false);
  expect(
    await redis
      .client()
      .sendCommand(["EXISTS", `{${keyPrefix}}:hash:${charge.paymentHash}`]),
  ).toBe(0);
});

it("rejects expired issuance using Redis time", async () => {
  const store = redisStore(redis.client(), { keyPrefix: namespace() });

  await expect(
    store.issue({ ...record(), expiresAt: Date.now() - 1 }),
  ).rejects.toThrow("expired");
});

it("isolates services with different namespaces", async () => {
  const charge = record();
  const first = redisStore(redis.client(), { keyPrefix: namespace() });
  const second = redisStore(redis.client(), { keyPrefix: namespace() });

  await first.issue(charge);
  expect(await second.get(charge.id)).toBeUndefined();
  await second.issue(charge);
  expect(await first.consume(charge.id)).toBe(true);
  expect(await second.consume(charge.id)).toBe(true);
});

it("fails closed when stored consumption state is corrupt", async () => {
  const keyPrefix = namespace();
  const store = redisStore(redis.client(), { keyPrefix });
  const charge = record();

  await store.issue(charge);
  await redis
    .client()
    .sendCommand(["HDEL", `{${keyPrefix}}:challenge:${charge.id}`, "consumed"]);
  await expect(store.consume(charge.id)).rejects.toThrow();
});

it("completes the paid HTTP flow across separate server instances using Redis", async () => {
  const keyPrefix = namespace();

  await paidHttpFlow(() => redisStore(redis.client(), { keyPrefix }));
});
