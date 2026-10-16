import { afterEach, expect, it, vi } from "vitest";
import { Challenge, Credential, Receipt, Errors } from "mppx";
import { Mppx, phoenixd } from "../src";
import { fakeNode, fixtureWallet } from "./helpers";
const secretKey = "a".repeat(64);
const endpoint = "https://api.example.test/query";
const input = (credential?: string, url = endpoint, body = "question") =>
  new Request(url, {
    method: "POST",
    body,
    ...(credential ? { headers: { Authorization: credential } } : {}),
  });
function configure(node = fakeNode()) {
  const method = phoenixd.charge({ client: node });
  const sdk = Mppx.create({ methods: [method], secretKey });
  return { node, method, sdk, handler: sdk.charge({ amount: "100" }) };
}
async function setup() {
  const config = configure();
  const result = await config.handler(input());
  if (result.status !== 402) throw new Error("Expected challenge");
  const wallet = fixtureWallet(config.node);
  const challenge = Challenge.fromResponse(result.challenge, {
    methods: [wallet],
  });
  const credential = await wallet.createCredential({ challenge });
  return { ...config, result, challenge, credential };
}
afterEach(() => vi.restoreAllMocks());

it("uses request and verify hooks to issue a standard challenge and receipt without another invoice on retry", async () => {
  const { node, method, result, handler, challenge, credential } =
    await setup();
  expect(typeof method.request).toBe("function");
  expect(typeof method.verify).toBe("function");
  expect(result.challenge.headers.get("Cache-Control")).toBe("no-store");
  expect(Challenge.verify(challenge, { secretKey })).toBe(true);
  const paid = await handler(input(credential));
  expect(paid.status).toBe(200);
  if (paid.status !== 200) return;
  const response = paid.withReceipt(Response.json({ result: "paid" }));
  const receipt = Receipt.fromResponse(response);
  expect(receipt.reference).toBe(challenge.request.methodDetails.paymentHash);
  expect(response.headers.get("Payment-Receipt")).not.toContain(
    node.invoices.get("lnbc-fixture-1")!.preimage,
  );
  expect(node.createInvoice).toHaveBeenCalledTimes(1);
  expect(node.decodeInvoice).toHaveBeenCalledTimes(1);
});

it("does not retain payment usage and verifies across independent instances", async () => {
  const { node, handler, credential } = await setup();
  const other = configure(node).handler;
  expect(
    (
      await Promise.all([handler(input(credential)), other(input(credential))])
    ).map((r) => r.status),
  ).toEqual([200, 200]);
  expect(node.createInvoice).toHaveBeenCalledTimes(1);
});

it("lets application code save original challenges and atomically redeem them by extending verify", async () => {
  const node = fakeNode();
  const base = phoenixd.charge({ client: node });
  const records = new Map<string, { serialized: string; used: boolean }>();
  const sdk = Mppx.create({
    methods: [
      {
        ...base,
        async verify(context: Parameters<typeof base.verify>[0]) {
          const receipt = await base.verify(context);
          const saved = records.get(context.credential.challenge.id);
          if (
            !saved ||
            saved.used ||
            saved.serialized !==
              Challenge.serialize(context.credential.challenge)
          )
            throw new Errors.PaymentRequiredError();
          saved.used = true;
          return receipt;
        },
      },
    ],
    secretKey,
  });
  const handler = async (request: Request) => {
    const result = await sdk.charge({ amount: "100" })(request);
    if (result.status === 402) {
      const challenge = Challenge.fromResponse(result.challenge);
      records.set(challenge.id, {
        serialized: Challenge.serialize(challenge),
        used: false,
      });
    }
    return result;
  };
  const offered = await handler(input());
  if (offered.status !== 402) throw new Error("Expected challenge");
  const wallet = fixtureWallet(node);
  const credential = await wallet.createCredential({
    challenge: Challenge.fromResponse(offered.challenge, { methods: [wallet] }),
  });
  const results = await Promise.all([
    handler(input(credential)),
    handler(input(credential)),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 402]);
  expect(node.createInvoice).toHaveBeenCalledTimes(2);
});

it("emits the actual issued challenge for application recording", async () => {
  const { sdk, handler } = configure();
  const created = vi.fn();
  sdk.onChallengeCreated(created);
  const result = await handler(input());
  if (result.status !== 402) throw new Error("Expected challenge");
  expect(created.mock.calls[0]![0].challenge.id).toBe(
    Challenge.fromResponse(result.challenge).id,
  );
});

it("rejects different URLs, methods, bodies and prices", async () => {
  const { handler, sdk, credential } = await setup();
  expect((await handler(input(credential, endpoint + "?other=1"))).status).toBe(
    402,
  );
  expect((await handler(input(credential, endpoint, "different"))).status).toBe(
    402,
  );
  expect(
    (
      await handler(
        new Request(endpoint, { headers: { Authorization: credential } }),
      )
    ).status,
  ).toBe(402);
  expect((await sdk.charge({ amount: "200" })(input(credential))).status).toBe(
    402,
  );
});

it("rejects wrong proofs and forged challenges and supplies a new invoice", async () => {
  const { handler, challenge, credential, node } = await setup();
  const wrong = Credential.serialize({
    challenge,
    payload: { preimage: "0".repeat(64) },
  });
  const invalid = await handler(input(wrong));
  expect(invalid.status).toBe(402);
  if (invalid.status !== 402) return;
  expect(Challenge.fromResponse(invalid.challenge).id).not.toBe(challenge.id);
  const forged = Credential.serialize({
    challenge: { ...challenge, id: "forged" },
    payload: Credential.deserialize(credential).payload,
  });
  expect((await handler(input(forged))).status).toBe(402);
  expect(node.createInvoice).toHaveBeenCalledTimes(3);
});

it("caps expiry to the invoice and rejects expired proof", async () => {
  const node = fakeNode();
  const sdk = Mppx.create({
    methods: [phoenixd.charge({ client: node, invoiceExpirySeconds: 5 })],
    secretKey,
  });
  const offered = await sdk.charge({
    amount: "100",
    expires: new Date(Date.now() + 3600000),
  })(input());
  if (offered.status !== 402) throw new Error("Expected challenge");
  const wallet = fixtureWallet(node);
  const challenge = Challenge.fromResponse(offered.challenge, {
    methods: [wallet],
  });
  const decoded = await node.decodeInvoice({ invoice: "lnbc-fixture-1" });
  expect(Date.parse(challenge.expires!)).toBe(
    (decoded.timestampSeconds + 5) * 1000,
  );
  const credential = await wallet.createCredential({ challenge });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(challenge.expires!));
  expect((await sdk.charge({ amount: "100" })(input(credential))).status).toBe(
    402,
  );
});

it("rejects standalone verification and node errors", async () => {
  const { method, node, challenge } = await setup();
  await expect(
    method.verify({
      credential: { challenge, payload: { preimage: "0".repeat(64) } },
      request: challenge.request,
    }),
  ).rejects.toMatchObject({ code: "invalid_challenge" });
  node.createInvoice.mockRejectedValueOnce(new Error("offline"));
  const fresh = configure(node);
  await expect(fresh.handler(input())).rejects.toMatchObject({
    code: "invalid_invoice",
  });
});
