import { describe, expect, it, vi } from "vitest";
import { Challenge, Credential } from "mppx";
import { phoenixd as server, Mppx } from "../src/server";
import { charge } from "../src/client/charge";
import { fakeNode } from "./helpers";
import type { OutgoingPayment } from "@nodana/phoenixd-ts";

async function setup() {
  const node = fakeNode();
  const mpp = Mppx.create({
    methods: [server.charge({ client: node })],
    secretKey: "a".repeat(64),
  });
  const response = await mpp.charge({ amount: "100" })(
    new Request("https://example.test/paid"),
  );

  if (response.status !== 402) throw new Error("Expected challenge");

  const method = charge({ client: node, maxAmountSat: 1000 });
  const challenge = Challenge.fromResponse(response.challenge, {
    methods: [method],
  });
  const invoice = node.invoices.get(challenge.request.methodDetails.invoice)!;
  const paid: OutgoingPayment = {
    type: "outgoing_payment",
    subType: "lightning",
    paymentId: "id",
    paymentHash: invoice.decoded.paymentHash,
    preimage: invoice.preimage,
    isPaid: true,
    sent: 100,
    fees: 0,
    completedAt: Date.now(),
    createdAt: Date.now(),
  };

  return { node, method, challenge, paid, invoice };
}

describe("Phoenixd payer", () => {
  it("rejects amounts above the caller limit without paying", async () => {
    const { node, challenge } = await setup();

    await expect(
      charge({ client: node, maxAmountSat: 99 }).createCredential({
        challenge,
      }),
    ).rejects.toMatchObject({ code: "amount_limit" });
    expect(node.payInvoice).not.toHaveBeenCalled();
  });

  it.each(["amount", "paymentHash", "network", "expired"] as const)(
    "rejects inconsistent %s before paying",
    async (field) => {
      const { node, method, challenge } = await setup();

      if (field === "amount") challenge.request.amount = "101";

      if (field === "paymentHash")
        challenge.request.methodDetails.paymentHash = "0".repeat(64);

      if (field === "network")
        challenge.request.methodDetails.network = "regtest";

      if (field === "expired") challenge.expires = new Date(0).toISOString();

      await expect(
        method.createCredential({ challenge }),
      ).rejects.toMatchObject({ code: "invalid_invoice" });
      expect(node.payInvoice).not.toHaveBeenCalled();
    },
  );

  it("rejects an invoice on a different configured network", async () => {
    const { node, challenge } = await setup();

    await expect(
      charge({
        client: node,
        maxAmountSat: 1000,
        network: "regtest",
      }).createCredential({ challenge }),
    ).rejects.toMatchObject({ code: "invalid_invoice" });
    expect(node.payInvoice).not.toHaveBeenCalled();
  });

  it("coalesces concurrent payment attempts for the same invoice", async () => {
    const { node, method, challenge } = await setup();
    const credentials = await Promise.all([
      method.createCredential({ challenge }),
      method.createCredential({ challenge }),
    ]);

    expect(credentials[0]).toBe(credentials[1]);
    expect(node.payInvoice).toHaveBeenCalledTimes(1);
  });

  it("uses a completed payment from history instead of sending another payment", async () => {
    const { node, method, challenge, paid, invoice } = await setup();

    node.getOutgoingPaymentByHash.mockResolvedValue(paid);

    const credential = await method.createCredential({ challenge });

    expect(Credential.deserialize(credential).payload).toEqual({
      preimage: invoice.preimage,
    });
    expect(node.payInvoice).not.toHaveBeenCalled();
  });

  it("rejects a pending payment instead of sending another payment", async () => {
    const { node, method, challenge, paid } = await setup();
    const { preimage: _preimage, completedAt: _completedAt, ...pending } = paid;

    node.getOutgoingPaymentByHash.mockResolvedValue({
      ...pending,
      isPaid: false,
    });
    await expect(method.createCredential({ challenge })).rejects.toMatchObject({
      code: "payment_unknown",
    });
    expect(node.payInvoice).not.toHaveBeenCalled();
  });

  it("does not pay an already paid invoice whose proof is missing", async () => {
    const { node, method, challenge, paid } = await setup();
    const { preimage: _preimage, ...withoutProof } = paid;

    node.getOutgoingPaymentByHash.mockResolvedValue(withoutProof);
    await expect(method.createCredential({ challenge })).rejects.toMatchObject({
      code: "payment_unknown",
    });
    expect(node.payInvoice).not.toHaveBeenCalled();
  });

  it("returns a typed error for malformed node proofs", async () => {
    const { node, method, challenge, paid } = await setup();

    node.getOutgoingPaymentByHash.mockResolvedValue({
      ...paid,
      preimage: "invalid",
    });
    await expect(method.createCredential({ challenge })).rejects.toMatchObject({
      code: "payment_unknown",
    });
    expect(node.payInvoice).not.toHaveBeenCalled();
  });

  it("returns a typed error for an HTTP-200 payment failure", async () => {
    const { node, method, challenge } = await setup();

    node.payInvoice.mockResolvedValue({
      type: "payment_failed",
      reason: "Insufficient balance",
    });
    await expect(method.createCredential({ challenge })).rejects.toMatchObject({
      code: "payment_failed",
    });
    expect(node.payInvoice).toHaveBeenCalledTimes(1);
  });

  it("recovers a successful payment from history after a network failure", async () => {
    const { node, method, challenge, paid } = await setup();

    node.payInvoice.mockRejectedValue(new Error("Socket closed"));
    node.getOutgoingPaymentByHash
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(paid);
    expect(typeof (await method.createCredential({ challenge }))).toBe(
      "string",
    );
    expect(node.payInvoice).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the payment outcome remains uncertain", async () => {
    const { node, method, challenge } = await setup();

    node.payInvoice.mockRejectedValue(new Error("Socket closed"));
    await expect(method.createCredential({ challenge })).rejects.toMatchObject({
      code: "payment_unknown",
    });
    expect(node.payInvoice).toHaveBeenCalledTimes(1);
  });

  it("rejects an incorrect proof returned by the node", async () => {
    const { node, method, challenge } = await setup();
    const valid = await node.payInvoice({
      invoice: challenge.request.methodDetails.invoice,
    });

    node.payInvoice.mockClear();

    if (valid.type !== "payment_sent") throw new Error("Expected sent result");

    node.payInvoice.mockResolvedValue({
      ...valid,
      paymentPreimage: "0".repeat(64),
    });
    await expect(method.createCredential({ challenge })).rejects.toMatchObject({
      code: "payment_unknown",
    });
  });

  it("rejects unsafe or malformed decimal amounts", async () => {
    const { node, method, challenge } = await setup();

    for (const amount of [
      "0",
      "-1",
      "1.5",
      "1e2",
      "1junk",
      "9007199254740991",
    ]) {
      await expect(
        method.createCredential({
          challenge: {
            ...challenge,
            request: { ...challenge.request, amount },
          },
        }),
      ).rejects.toBeDefined();
    }

    expect(node.payInvoice).not.toHaveBeenCalled();
  });
});
