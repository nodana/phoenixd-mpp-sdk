// Lightning wire schema adapted from buildonspark/lightning-mpp-sdk (MIT).
// Copyright (c) 2026 Lightspark Group, Inc. See NOTICE.
import { Method, z } from "mppx";

export const charge = Method.from({
  name: "lightning",
  intent: "charge",
  schema: {
    credential: {
      payload: z.object({
        preimage: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
      }),
    },
    request: z.object({
      amount: z.string().check(z.regex(/^[1-9][0-9]*$/)),
      currency: z.literal("sat"),
      description: z.optional(z.string()),
      methodDetails: z.object({
        invoice: z.string(),
        requestBinding: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
        expiresAt: z.optional(z.number()),
        paymentHash: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
        network: z.optional(z.enum(["mainnet", "regtest", "signet"])),
      }),
    }),
  },
});

export type ChargeRequest = z.output<typeof charge.schema.request>;

export type LightningNetwork = NonNullable<
  ChargeRequest["methodDetails"]["network"]
>;
