import { expect, it } from "vitest";
import { satoshis } from "../src/shared";
it("converts integer satoshis exactly within Phoenixd's millisatoshi range", () => {
  expect(satoshis("9007199254740")).toBe(9007199254740);
  expect(() => satoshis("9007199254741")).toThrow();
  for (const amount of ["0", "-1", "1.1", "001", "1e3", "Infinity"])
    expect(() => satoshis(amount)).toThrow();
  // @ts-expect-error JavaScript callers must also supply a string.
  expect(() => satoshis(100)).toThrow();
});
