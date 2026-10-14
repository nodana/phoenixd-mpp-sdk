/** Stored values contain no payment preimages or node credentials. */
export interface StoredCharge {
  readonly id: string;
  readonly serializedChallenge: string;
  readonly paymentHash: string;
  readonly amountSat: number;
  readonly expiresAt: number;
  readonly requestUrl: string;
  readonly requestMethod: string;
  readonly bodyHash: string;
}

export interface ChargeStore {
  /** Persist before responding with a challenge. Reject reused IDs/payment hashes. */
  issue(charge: StoredCharge): Promise<void>;
  get(id: string): Promise<StoredCharge | undefined>;
  /** Atomically succeeds once, and only while the stored challenge is unexpired. */
  consume(id: string): Promise<boolean>;
}

export interface ManagedChargeStore extends ChargeStore {
  pruneExpired(): Promise<number>;
}

const validId = (id: string) =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);

function assertRecord(value: unknown): asserts value is StoredCharge {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Invalid stored challenge");

  const record = value as StoredCharge;

  if (
    !validId(record.id) ||
    !/^[0-9a-f]{64}$/.test(record.paymentHash) ||
    !/^[0-9a-f]{64}$/.test(record.bodyHash) ||
    !Number.isSafeInteger(record.amountSat) ||
    record.amountSat < 1 ||
    !Number.isSafeInteger(record.expiresAt) ||
    typeof record.serializedChallenge !== "string" ||
    typeof record.requestUrl !== "string" ||
    typeof record.requestMethod !== "string"
  ) {
    throw new TypeError("Invalid stored challenge");
  }
}

export function memoryStore(
  options: { maxEntries?: number } = {},
): ManagedChargeStore {
  const maxEntries = options.maxEntries ?? 10_000;

  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new TypeError("maxEntries must be positive");

  const entries = new Map<
    string,
    { charge: StoredCharge; consumed: boolean }
  >();
  const hashes = new Set<string>();

  const prune = () => {
    let removed = 0;

    for (const [id, entry] of entries)
      if (entry.charge.expiresAt <= Date.now()) {
        entries.delete(id);
        hashes.delete(entry.charge.paymentHash);
        removed++;
      }

    return removed;
  };

  return {
    async issue(charge) {
      assertRecord(charge);

      if (charge.expiresAt <= Date.now()) throw new Error("Charge has expired");

      prune();

      if (entries.size >= maxEntries)
        throw new Error("Charge store capacity reached");

      if (entries.has(charge.id) || hashes.has(charge.paymentHash))
        throw new Error("Charge already issued");

      entries.set(charge.id, {
        charge: structuredClone(charge),
        consumed: false,
      });
      hashes.add(charge.paymentHash);
    },

    async get(id) {
      return entries.has(id)
        ? structuredClone(entries.get(id)!.charge)
        : undefined;
    },

    async consume(id) {
      const entry = entries.get(id);

      if (!entry || entry.consumed || entry.charge.expiresAt <= Date.now())
        return false;

      entry.consumed = true;

      return true;
    },

    async pruneExpired() {
      return prune();
    },
  };
}

/** Compatible with a connected node-redis client using its default reply types. */
export interface RedisClient {
  sendCommand(args: string[]): Promise<unknown>;
}

export interface RedisStoreOptions {
  /** Namespace shared by instances of this service. Defaults to phoenixd-mpp. */
  keyPrefix?: string;
}

// Both keys share a hash tag. All checks and writes run in one Redis operation.
const issueScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expires = tonumber(ARGV[2])
if expires <= now then return -1 end
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'record', ARGV[1], 'expires', ARGV[2], 'consumed', '0')
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('PEXPIREAT', KEYS[2], ARGV[2])
return 1
`;

const consumeScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local expires = tonumber(redis.call('HGET', KEYS[1], 'expires'))
local consumed = redis.call('HGET', KEYS[1], 'consumed')
if not expires or (consumed ~= '0' and consumed ~= '1') then
  return redis.error_reply('Invalid stored payment challenge')
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if expires <= now or consumed == '1' then return 0 end
redis.call('HSET', KEYS[1], 'consumed', '1')
return 1
`;

/** Shared payment state; Redis expires records automatically. Does not own the connection. */
export function redisStore(
  client: RedisClient,
  options: RedisStoreOptions = {},
): ChargeStore {
  const prefix = options.keyPrefix ?? "phoenixd-mpp";

  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(prefix))
    throw new TypeError("Invalid Redis keyPrefix");

  const root = `{${prefix}}:`;

  const key = (id: string) => `${root}challenge:${id}`;

  return {
    async issue(charge) {
      assertRecord(charge);

      // Serialize before awaiting so caller mutations cannot change issued state.
      const result = await client.sendCommand([
        "EVAL",
        issueScript,
        "2",
        key(charge.id),
        `${root}hash:${charge.paymentHash}`,
        JSON.stringify(charge),
        String(charge.expiresAt),
        charge.id,
      ]);

      if (result === -1) throw new Error("Charge has expired");

      if (result === 0) throw new Error("Charge already issued");

      if (result !== 1) throw new Error("Unexpected Redis issuance response");
    },

    async get(id) {
      if (!validId(id)) return undefined;

      const value = await client.sendCommand(["HGET", key(id), "record"]);

      if (value === null) return undefined;

      if (typeof value !== "string")
        throw new TypeError("Invalid Redis record response");

      const record: unknown = JSON.parse(value);

      assertRecord(record);

      if (record.id !== id)
        throw new TypeError("Stored challenge ID does not match");

      return record;
    },

    async consume(id) {
      if (!validId(id)) return false;

      const result = await client.sendCommand([
        "EVAL",
        consumeScript,
        "1",
        key(id),
      ]);

      if (result !== 0 && result !== 1)
        throw new Error("Unexpected Redis consumption response");

      return result === 1;
    },
  };
}
