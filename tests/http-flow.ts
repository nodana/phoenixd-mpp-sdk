import { expect } from "vitest";
import { Phoenixd } from "@nodana/phoenixd-ts";
import {
  Mppx as Server,
  phoenixd as receive,
  type ChargeStore,
} from "../src/server";
import { Mppx as Client, phoenixd as send } from "../src/client";
import { fakeNode } from "./helpers";

export async function paidHttpFlow(
  createStore: () => ChargeStore,
): Promise<void> {
  const fixture = fakeNode();
  const calls: string[] = [];

  const nodeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);

    expect(request.headers.get("Authorization")).toBe(
      `Basic ${Buffer.from(":node-password").toString("base64")}`,
    );

    const url = new URL(request.url);

    calls.push(url.pathname);

    if (url.pathname.startsWith("/payments/outgoingbyhash/"))
      return new Response(null, { status: 404 });

    expect(request.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );

    const params = new URLSearchParams(await request.text());

    if (url.pathname === "/createinvoice")
      return Response.json(
        await fixture.createInvoice({
          amountSat: Number(params.get("amountSat")),
          description: params.get("description")!,
          expirySeconds: Number(params.get("expirySeconds")),
        }),
      );

    if (url.pathname === "/decodeinvoice")
      return Response.json(
        await fixture.decodeInvoice({ invoice: params.get("invoice")! }),
      );

    if (url.pathname === "/payinvoice")
      return Response.json(
        await fixture.payInvoice({ invoice: params.get("invoice")! }),
      );

    throw new Error(`Unexpected node endpoint: ${url.pathname}`);
  };

  const node = new Phoenixd("https://node.example.test", "node-password", {
    fetch: nodeFetch,
  });

  const createServer = () =>
    Server.create({
      methods: [receive.charge({ client: node, store: createStore() })],
      secretKey: "a".repeat(64),
    });

  let server = createServer();
  const bodies: string[] = [];
  let authorized: Request | undefined;

  const apiFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);

    bodies.push(await request.clone().text());

    const result = await server.charge({ amount: "100" })(request);

    if (result.status === 402) {
      // Recreate the handler between challenge and credential requests.
      server = createServer();

      return result.challenge;
    }

    authorized = request.clone();

    return result.withReceipt(
      Response.json({ answer: "paid result", body: await request.text() }),
    );
  };

  const payer = Client.create({
    methods: [send.charge({ client: node, maxAmountSat: 100 })],
    fetch: apiFetch,
    polyfill: false,
  });
  const response = await payer.fetch("https://api.example.test/query", {
    method: "POST",
    body: "question",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    answer: "paid result",
    body: "question",
  });
  expect(response.headers.get("Payment-Receipt")).toBeTruthy();
  expect(bodies).toEqual(["question", "question"]);
  expect(fixture.createInvoice).toHaveBeenCalledTimes(1);
  expect(fixture.payInvoice).toHaveBeenCalledTimes(1);
  expect(calls.filter((path) => path === "/decodeinvoice")).toHaveLength(2);
  server = createServer();
  expect((await server.charge({ amount: "100" })(authorized!)).status).toBe(
    402,
  );
}
