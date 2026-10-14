import { it } from "vitest";
import { memoryStore } from "../src/server";
import { paidHttpFlow } from "./http-flow";

it("uses the real Phoenixd HTTP client with payment-aware fetch and recreated handlers", async () => {
  const store = memoryStore();

  await paidHttpFlow(() => store);
});
