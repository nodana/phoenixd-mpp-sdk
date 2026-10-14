import { beforeEach, describe, expect, it, vi } from "vitest";
import { Challenge, Credential, Receipt } from "mppx";
import { Mppx, phoenixd, memoryStore } from "../src/server";
import { charge as clientCharge } from "../src/client/charge";
import type { ChargeStore } from "../src/server";
import { fakeNode } from "./helpers";

const secretKey = "a".repeat(64);

const endpoint = "https://api.example.test/weather";

function setup(store: ChargeStore = memoryStore()) {
  const node = fakeNode();
  const mpp = Mppx.create({
    methods: [phoenixd.charge({ client: node, store })],
    secretKey,
  });
  const method = clientCharge({ client: node, maxAmountSat: 1000 });
  const handler = mpp.charge({ amount: "100", description: "Weather report" });

  const request = (credential?: string, url = endpoint, body?: string) =>
    new Request(url, {
      ...(body === undefined ? {} : { method: "POST", body }),
      ...(credential === undefined
        ? {}
        : { headers: { Authorization: credential } }),
    });

  const issue = async (input = request()) => {
    const result = await handler(input);

    if (result.status !== 402) throw new Error("Expected payment challenge");

    return {
      response: result.challenge,
      challenge: Challenge.fromResponse(result.challenge, {
        methods: [method],
      }),
    };
  };

  return { node, mpp, method, handler, request, issue, store };
}

beforeEach(() => vi.restoreAllMocks());

describe("Lightning charge HTTP flow", () => {
  it("issues, pays, serves and returns a receipt without an extra invoice on retry", async () => {
    const { node, handler, request, issue, method } = setup();
    const { response, challenge } = await issue();

    expect(response.status).toBe(402);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(challenge.method).toBe("lightning");
    expect(challenge.request.amount).toBe("100");
    expect(challenge.request.methodDetails.invoice).toBe("lnbc-fixture-1");
    expect(Challenge.verify(challenge, { secretKey })).toBe(true);
    expect(node.createInvoice).toHaveBeenCalledWith({
      amountSat: 100,
      description: "Weather report",
      expirySeconds: 3600,
    });

    const credential = await method.createCredential({ challenge });
    const result = await handler(request(credential));

    expect(result.status).toBe(200);

    if (result.status !== 200) return;

    const paid = result.withReceipt(Response.json({ weather: "sunny" }));

    expect(await paid.json()).toEqual({ weather: "sunny" });

    const receipt = Receipt.fromResponse(paid);

    expect(receipt.reference).toBe(challenge.request.methodDetails.paymentHash);
    expect(receipt.status).toBe("success");
    expect(paid.headers.get("Cache-Control")).toBe("no-store");
    expect(paid.headers.get("Payment-Receipt")).not.toContain(
      node.invoices.get("lnbc-fixture-1")!.preimage,
    );
    expect(node.createInvoice).toHaveBeenCalledTimes(1);
    expect(node.payInvoice).toHaveBeenCalledTimes(1);
  });

  it("emits the actual issued challenge through lifecycle events", async () => {
    const { mpp, issue } = setup();
    const onCreated = vi.fn();

    mpp.onChallengeCreated(onCreated);

    const { challenge } = await issue();

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated.mock.calls[0]![0].challenge.id).toBe(challenge.id);
    expect(onCreated.mock.calls[0]![0].request.methodDetails.invoice).toBe(
      challenge.request.methodDetails.invoice,
    );
  });

  it("accepts exactly one of two concurrent uses and gives the rejected use a fresh invoice", async () => {
    const { handler, request, issue, method } = setup();
    const { challenge } = await issue();
    const credential = await method.createCredential({ challenge });
    const results = await Promise.all([
      handler(request(credential)),
      handler(request(credential)),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 402]);

    const rejected = results.find((r) => r.status === 402)!;

    if (rejected.status !== 402) return;

    const fresh = Challenge.fromResponse(rejected.challenge, {
      methods: [method],
    });

    expect(fresh.request.methodDetails.paymentHash).not.toBe(
      challenge.request.methodDetails.paymentHash,
    );

    const next = await handler(
      request(await method.createCredential({ challenge: fresh })),
    );

    expect(next.status).toBe(200);
  });

  it("rejects a wrong preimage and permits paying its fresh challenge", async () => {
    const { handler, request, issue, method } = setup();
    const { challenge } = await issue();
    const invalid = Credential.serialize({
      challenge,
      payload: { preimage: "0".repeat(64) },
    });
    const result = await handler(request(invalid));

    expect(result.status).toBe(402);

    if (result.status !== 402) return;

    const fresh = Challenge.fromResponse(result.challenge, {
      methods: [method],
    });

    expect(fresh.id).not.toBe(challenge.id);
    expect(
      (
        await handler(
          request(await method.createCredential({ challenge: fresh })),
        )
      ).status,
    ).toBe(200);
  });

  it("rejects forged challenge data and price changes", async () => {
    const { handler, mpp, request, issue, method } = setup();
    const { challenge } = await issue();
    const credential = await method.createCredential({ challenge });

    expect(
      (await mpp.charge({ amount: "200" })(request(credential))).status,
    ).toBe(402);

    const tampered = structuredClone(challenge);

    tampered.request.amount = "1";

    const proof = Credential.deserialize(credential).payload as {
      preimage: string;
    };

    expect(
      (
        await handler(
          request(
            Credential.serialize({ challenge: tampered, payload: proof }),
          ),
        )
      ).status,
    ).toBe(402);
  });

  it("rejects valid proof on another URL or request body", async () => {
    const { handler, request, issue, method } = setup();
    const { challenge } = await issue(request(undefined, endpoint, "original"));
    const credential = await method.createCredential({ challenge });

    expect(
      (await handler(request(credential, endpoint, "changed"))).status,
    ).toBe(402);
    expect(
      (
        await handler(
          request(credential, "https://api.example.test/other", "original"),
        )
      ).status,
    ).toBe(402);
    expect(
      (await handler(request(credential, endpoint, "original"))).status,
    ).toBe(200);
  });

  it("caps challenge expiry to the invoice expiry and rejects expired credentials", async () => {
    const { mpp, request, node, method } = setup();
    const shortMpp = Mppx.create({
      methods: [phoenixd.charge({ client: node, invoiceExpirySeconds: 5 })],
      secretKey,
    });
    const result = await shortMpp.charge({
      amount: "100",
      expires: new Date(Date.now() + 3_600_000),
    })(request());

    if (result.status !== 402) throw new Error("Expected challenge");

    const challenge = Challenge.fromResponse(result.challenge, {
      methods: [method],
    });
    const decoded = await node.decodeInvoice({
      invoice: challenge.request.methodDetails.invoice,
    });

    expect(Date.parse(challenge.expires!)).toBe(
      (decoded.timestampSeconds + 5) * 1000,
    );

    const credential = await method.createCredential({ challenge });

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);

    const rejected = await mpp.charge({ amount: "100" })(request(credential));

    expect(rejected.status).toBe(402);
  });

  it("rejects unsigned but otherwise matching proofs before accessing the protected result", async () => {
    const { handler, request, issue, method } = setup();
    const { challenge } = await issue();
    const credential = await method.createCredential({ challenge });
    const proof = Credential.deserialize(credential).payload;
    const forged = { ...challenge, id: "forged" };

    expect(
      (
        await handler(
          request(Credential.serialize({ challenge: forged, payload: proof })),
        )
      ).status,
    ).toBe(402);
  });

  it("fails closed when durable issuance or consumption fails", async () => {
    const store = memoryStore();
    const { handler, request, issue, method } = setup(store);
    const { challenge } = await issue();
    const credential = await method.createCredential({ challenge });

    vi.spyOn(store, "consume").mockRejectedValue(new Error("disk unavailable"));

    const failed = await handler(request(credential));

    expect(failed.status).toBe(402);

    if (failed.status === 402) expect(failed.challenge.status).toBe(503);

    vi.spyOn(store, "issue").mockRejectedValue(new Error("disk unavailable"));
    await expect(issue()).rejects.toMatchObject({ code: "store_unavailable" });
  });

  it("rejects malformed credentials and generates a usable replacement", async () => {
    const { handler, request, method } = setup();
    const result = await handler(request("Payment nonsense"));

    expect(result.status).toBe(402);

    if (result.status !== 402) return;

    const challenge = Challenge.fromResponse(result.challenge, {
      methods: [method],
    });

    expect(
      (await handler(request(await method.createCredential({ challenge }))))
        .status,
    ).toBe(200);
  });
});
