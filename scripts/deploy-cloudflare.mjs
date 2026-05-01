import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const databaseName = process.env.DAOYI_D1_NAME || "daoyi-monitor";
const binding = "DB";

run("npm", ["run", "build"]);

const database = findDatabase(databaseName) ?? createDatabase(databaseName);
patchWranglerDatabaseId(database.uuid || database.database_id || database.id);

run("wrangler", ["d1", "migrations", "apply", binding, "--remote"]);
run("wrangler", ["deploy"]);

function findDatabase(name) {
  const output = run("wrangler", ["d1", "list", "--json"], { capture: true });
  const list = JSON.parse(output);
  return list.find((item) => item.name === name) ?? null;
}

function createDatabase(name) {
  run("wrangler", [
    "d1",
    "create",
    name,
    "--binding",
    binding,
    "--use-remote",
    "--update-config",
  ]);
  const database = findDatabase(name);
  if (!database) {
    throw new Error(`D1 database was created but not found in list: ${name}`);
  }
  return database;
}

function patchWranglerDatabaseId(databaseId) {
  if (!databaseId || typeof databaseId !== "string") {
    throw new Error("Cannot determine D1 database id.");
  }

  const path = "wrangler.toml";
  const before = readFileSync(path, "utf8");
  const after = before.replace(
    /database_id\s*=\s*"[^"]+"/,
    `database_id = "${databaseId}"`,
  );
  if (before !== after) {
    writeFileSync(path, after);
  }
}

function run(command, args, options = {}) {
  const result = execFileSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    shell: process.platform === "win32",
  });
  return options.capture ? result : "";
}
