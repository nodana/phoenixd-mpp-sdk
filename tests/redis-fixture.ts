import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RedisClient } from "../src/server";

const execute = promisify(execFile);

/** Disposable real Redis instance; never touches an existing Redis service. */
export async function redisFixture() {
  const directory = await mkdtemp("/tmp/pmpp-");
  const socket = join(directory, "redis.sock");
  let process: ChildProcess | undefined;

  const client = (): RedisClient => ({
    async sendCommand(args) {
      const { stdout } = await execute(
        "redis-cli",
        ["-s", socket, "--json", ...args],
        { timeout: 5000 },
      );
      const result: unknown = JSON.parse(stdout);

      if (typeof result === "object" && result !== null && "error" in result)
        throw new Error(String(result.error));

      return result;
    },
  });

  const stop = async () => {
    if (!process || process.exitCode !== null) return;

    const exited = once(process, "exit");

    process.kill("SIGTERM");
    await exited;
  };

  const start = async () => {
    let failure: Error | undefined;
    let logs = "";

    process = spawn(
      "redis-server",
      [
        "--port",
        "0",
        "--unixsocket",
        socket,
        "--unixsocketperm",
        "700",
        "--dir",
        directory,
        "--save",
        "",
        "--appendonly",
        "yes",
        "--appendfsync",
        "always",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    process.on("error", (error) => {
      failure = error;
    });
    process.stdout?.on("data", (data) => {
      logs += String(data);
    });
    process.stderr?.on("data", (data) => {
      logs += String(data);
    });

    for (let attempt = 0; attempt < 50; attempt++) {
      if (failure) throw failure;

      if (process.exitCode !== null)
        throw new Error(`Redis exited during startup: ${logs}`);

      try {
        if ((await client().sendCommand(["PING"])) === "PONG") return;
      } catch {
        /* Wait for socket readiness. */
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Redis did not start: ${logs}`);
  };

  try {
    await start();
  } catch (error) {
    await stop();
    await rm(directory, { recursive: true, force: true });

    throw error;
  }

  return {
    client,

    async restart() {
      await stop();
      await start();
    },

    async close() {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
