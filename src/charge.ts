import { Challenge, Method, Receipt } from "mppx";
import { Transport } from "mppx/server";
import type { PhoenixdClient } from "@nodana/phoenixd-ts";
import * as Methods from "./Methods";
import { ChargeError } from "./errors";
import { bodyHash, invoiceDetails, paymentHash, satoshis } from "./shared";
import { createHash } from "node:crypto";

export interface ChargeOptions {
  client: Pick<PhoenixdClient, "createInvoice" | "decodeInvoice">;
  invoiceExpirySeconds?: number;
  network?: Methods.LightningNetwork;
}

const defaults = { currency: "sat", methodDetails: { invoice: "" } } as const;
export type ChargeMethod = Method.Server<
  typeof Methods.charge,
  typeof defaults,
  Transport.Http
>;
interface Context {
  secretKey: string;
  binding: string;
  issued?: Methods.ChargeRequest;
  failure?: ChargeError;
}

/** An MPP server method. Application code owns challenge records and redemption. */
export function charge({
  client,
  network,
  invoiceExpirySeconds = 3600,
}: ChargeOptions): ChargeMethod {
  if (!Number.isSafeInteger(invoiceExpirySeconds) || invoiceExpirySeconds < 1)
    throw new TypeError("invoiceExpirySeconds must be a positive integer");
  // Transient HTTP invocation context only; no payment or replay records are retained.
  const byInput = new WeakMap<Request, Context>();
  const byCaptured = new WeakMap<Method.CapturedRequest, Context>();
  const http = Transport.http();

  async function issue(
    request: Methods.ChargeRequest,
    context: Context,
  ): Promise<Methods.ChargeRequest> {
    const amountSat = satoshis(request.amount);
    try {
      const created = await client.createInvoice({
        amountSat,
        description: request.description ?? "Paid API request",
        expirySeconds: invoiceExpirySeconds,
      });
      const details = invoiceDetails(
        await client.decodeInvoice({ invoice: created.serialized }),
        request,
        network,
      );
      if (
        created.paymentHash !== details.paymentHash ||
        created.amountSat !== amountSat
      )
        throw new Error("Invoice does not match Phoenixd response");
      return {
        ...request,
        methodDetails: {
          invoice: created.serialized,
          paymentHash: details.paymentHash,
          network: details.network,
          expiresAt: details.expiresAt,
          requestBinding: context.binding,
        },
      };
    } catch {
      context.failure = new ChargeError(
        "invalid_invoice",
        "Phoenixd could not provide a matching, unexpired invoice",
      );
      throw context.failure;
    }
  }

  return Method.toServer(Methods.charge, {
    defaults,
    async preflight({ input, capturedRequest, secretKey }) {
      const binding = createHash("sha256")
        .update(
          JSON.stringify([input.url, input.method, await bodyHash(input)]),
        )
        .digest("hex");
      const context: Context = { secretKey, binding };
      byInput.set(input, context);
      if (capturedRequest) byCaptured.set(capturedRequest, context);
      return undefined;
    },
    async request({ request, credential, capturedRequest }) {
      const context = capturedRequest && byCaptured.get(capturedRequest);
      if (!context)
        throw new ChargeError(
          "invalid_challenge",
          "Use the configured HTTP payment handler",
        );
      const parsed = Methods.charge.schema.request.parse(request);
      satoshis(parsed.amount);
      if (credential) {
        // Reuse invoice details on the paid retry; mppx authenticates the echoed challenge.
        const echoed = Methods.charge.schema.request.safeParse(
          credential.challenge.request,
        );
        if (echoed.success)
          return {
            ...parsed,
            methodDetails: {
              ...echoed.data.methodDetails,
              requestBinding: context.binding,
            },
          };
      }
      context.issued = await issue(parsed, context);
      return context.issued;
    },
    stableBinding: (request) => ({
      amount: request.amount,
      currency: request.currency,
      requestBinding: request.methodDetails.requestBinding,
    }),
    transport: {
      ...http,
      async respondChallenge(
        parameters: Parameters<Transport.Http["respondChallenge"]>[0],
      ) {
        const context = byInput.get(parameters.input);
        if (!context)
          throw new ChargeError(
            "invalid_challenge",
            "Use the configured HTTP payment handler",
          );
        if (context.failure) throw context.failure;
        const original = parameters.challenge;
        const request = Methods.charge.schema.request.parse(original.request);
        // Rejected credentials receive a fresh invoice; the initial request already created one.
        const issuedRequest = context.issued ?? (await issue(request, context));
        const expiresAt = Math.min(
          original.expires === undefined
            ? Date.now() + 300_000
            : Date.parse(original.expires),
          issuedRequest.methodDetails.expiresAt!,
        );
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
          throw new ChargeError(
            "invoice_expired",
            "The payment challenge has expired",
          );
        const issued = Challenge.from({
          secretKey: context.secretKey,
          realm: original.realm,
          method: "lightning",
          intent: "charge",
          request: issuedRequest,
          expires: new Date(expiresAt),
          ...(original.description === undefined
            ? {}
            : { description: original.description }),
          ...(original.opaque === undefined ? {} : { opaque: original.opaque }),
          ...(original.digest === undefined ? {} : { digest: original.digest }),
          ...(original.header === undefined ? {} : { header: original.header }),
        });
        Object.assign(original.request, issuedRequest);
        Object.assign(original, issued, { request: original.request });
        return http.respondChallenge({ ...parameters, challenge: original });
      },
      respondReceipt(
        parameters: Parameters<Transport.Http["respondReceipt"]>[0],
      ) {
        const response = http.respondReceipt(parameters);
        response.headers.set("Cache-Control", "no-store");
        return response;
      },
    },
    async verify({ credential, request, envelope }) {
      const context = envelope && byCaptured.get(envelope.capturedRequest);
      if (
        !context ||
        !Challenge.verify(credential.challenge, {
          secretKey: context.secretKey,
        })
      )
        throw new ChargeError(
          "invalid_challenge",
          "The challenge was not issued by this application",
        );
      const original = Methods.charge.schema.request.parse(
        credential.challenge.request,
      );
      if (
        original.currency !== "sat" ||
        original.amount !== request.amount ||
        original.methodDetails.requestBinding !== context.binding
      )
        throw new ChargeError(
          "invalid_challenge",
          "The credential does not match this request",
        );
      const expiresAt = Math.min(
        Date.parse(credential.challenge.expires ?? ""),
        original.methodDetails.expiresAt ?? NaN,
      );
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
        throw new ChargeError(
          "invoice_expired",
          "The payment challenge has expired",
        );
      if (network !== undefined && original.methodDetails.network !== network)
        throw new ChargeError(
          "invalid_challenge",
          "The invoice network does not match",
        );
      let hash: string;
      try {
        hash = paymentHash(credential.payload.preimage);
      } catch {
        throw new ChargeError(
          "invalid_preimage",
          "The payment proof is invalid",
        );
      }
      if (hash !== original.methodDetails.paymentHash)
        throw new ChargeError(
          "invalid_preimage",
          "The payment proof does not match the invoice",
        );
      return Receipt.from({
        method: "lightning",
        reference: hash,
        challengeId: credential.challenge.id,
        status: "success",
        timestamp: new Date().toISOString(),
      });
    },
  });
}
