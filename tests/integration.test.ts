import { Challenge } from "mppx";
import { expect, it } from "vitest";
import { Phoenixd } from "@nodana/phoenixd-ts";
import { Mppx, phoenixd } from "../src";
import { fakeNode, fixtureWallet } from "./helpers";

it("uses a real Phoenixd HTTP client for receiving only, and preserves the request body", async () => {
  const fixture = fakeNode();
  const calls: string[] = [];
  const node = new Phoenixd(
    "https://node.example.test",
    "restricted-password",
    {
      fetch: async (input, init) => {
        const req = new Request(input, init);
        expect(req.headers.get("Authorization")).toBe(
          `Basic ${Buffer.from(":restricted-password").toString("base64")}`,
        );
        expect(req.headers.get("Content-Type")).toBe(
          "application/x-www-form-urlencoded",
        );
        const path = new URL(req.url).pathname;
        calls.push(path);
        const params = new URLSearchParams(await req.text());
        if (path === "/createinvoice")
          return Response.json(
            await fixture.createInvoice({
              amountSat: Number(params.get("amountSat")),
              description: params.get("description")!,
              expirySeconds: Number(params.get("expirySeconds")),
            }),
          );
        if (path === "/decodeinvoice")
          return Response.json(
            await fixture.decodeInvoice({ invoice: params.get("invoice")! }),
          );
        throw new Error(`Unexpected node call ${path}`);
      },
    },
  );
  const sdk = () =>
    Mppx.create({
      methods: [phoenixd.charge({ client: node })],
      secretKey: "a".repeat(64),
    });
  const input = () =>
    new Request("https://api.example.test/query", {
      method: "POST",
      body: "question",
    });
  const offer = await sdk().charge({ amount: "100" })(input());
  if (offer.status !== 402) throw new Error("Expected challenge");
  const challenge = Challenge.fromResponse(offer.challenge, {
    methods: [fixtureWallet(fixture)],
  });
  const credential = await fixtureWallet(fixture).createCredential({
    challenge,
  });
  const retry = input();
  retry.headers.set("Authorization", credential);
  const proof = await sdk().charge({ amount: "100" })(retry);
  expect(proof.status).toBe(200);
  expect(await retry.text()).toBe("question");
  expect(calls).toEqual(["/createinvoice", "/decodeinvoice"]);
});
