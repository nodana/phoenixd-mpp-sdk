import { createHash } from "node:crypto";
import { vi } from "vitest";
import type {
  CreateInvoiceResponse,
  DecodedInvoice,
  PhoenixdClient,
} from "@nodana/phoenixd-ts";

export function fakeNode() {
  let sequence = 0;
  const invoices = new Map<
    string,
    { decoded: DecodedInvoice; preimage: string }
  >();
  const createInvoice = vi
    .fn<PhoenixdClient["createInvoice"]>()
    .mockImplementation(async (params) => {
      const preimage = (++sequence).toString(16).padStart(64, "0");
      const paymentHash = createHash("sha256")
        .update(Buffer.from(preimage, "hex"))
        .digest("hex");
      const serialized = `lnbc-fixture-${sequence}`;
      const decoded: DecodedInvoice = {
        chain: "mainnet",
        amount: params.amountSat! * 1000,
        paymentHash,
        paymentSecret: "secret",
        description: params.description ?? null,
        extraHops: [],
        timestampSeconds: Math.floor(Date.now() / 1000),
        expirySeconds: params.expirySeconds ?? 3600,
      };

      invoices.set(serialized, { decoded, preimage });

      return {
        amountSat: params.amountSat,
        paymentHash,
        serialized,
      } as CreateInvoiceResponse;
    });
  const decodeInvoice = vi
    .fn<PhoenixdClient["decodeInvoice"]>()
    .mockImplementation(async ({ invoice }) => {
      const value = invoices.get(invoice);

      if (!value) throw new Error("Unknown fixture invoice");

      return structuredClone(value.decoded);
    });
  const getOutgoingPaymentByHash = vi
    .fn<PhoenixdClient["getOutgoingPaymentByHash"]>()
    .mockResolvedValue(null);
  const payInvoice = vi
    .fn<PhoenixdClient["payInvoice"]>()
    .mockImplementation(async ({ invoice }) => {
      const value = invoices.get(invoice)!;

      return {
        type: "payment_sent",
        paymentHash: value.decoded.paymentHash,
        paymentPreimage: value.preimage,
        paymentId: "uuid",
        recipientAmountSat: value.decoded.amount! / 1000,
        routingFeeSat: 1,
      };
    });

  return {
    createInvoice,
    decodeInvoice,
    getOutgoingPaymentByHash,
    payInvoice,
    invoices,
  };
}
