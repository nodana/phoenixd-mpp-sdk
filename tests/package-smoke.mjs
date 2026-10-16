import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Mppx, phoenixd, Methods } from "@nodana/phoenixd-mpp-sdk";
const require = createRequire(import.meta.url);
const cjs = require("@nodana/phoenixd-mpp-sdk");
assert.equal(typeof Mppx.create, "function");
assert.equal(typeof cjs.Mppx.create, "function");
assert.equal(typeof phoenixd.charge, "function");
assert.equal(Methods.charge.name, "lightning");
assert.equal("memoryStore" in cjs, false);
assert.equal("redisStore" in cjs, false);

const result = spawnSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "tests/exports.mts",
    "tests/exports.cts",
  ],
  { stdio: "inherit" },
);

assert.equal(
  result.status,
  0,
  "Published declarations must work for ESM and CommonJS consumers",
);

console.log(
  "Package exports and consumer declarations passed (ESM + CommonJS).",
);
