// Offline configuration, migration-invocation and loader-resolution fixtures.
// No package manager, lifecycle script, network or live agent directory runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { configureNpmCommand, NPM_COMMAND } from "./set-npm-command.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.PI_SANDBOX_SCRATCH ?? os.tmpdir(), "npm-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  return { root, write };
}

function runner() {
  const calls = [];
  return { calls, run: (...args) => { calls.push(args); return { status: 0 }; }, log: () => {} };
}

test("new installs persist the hoisted command without running pnpm", (t) => {
  const { root } = fixture(t);
  const stub = runner();
  configureNpmCommand(root, stub);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "settings.json"))), { npmCommand: NPM_COMMAND });
  assert.deepEqual(stub.calls, []);
});

for (const metadata of ["nodeLinker: isolated\n", '{\n  "nodeLinker": "isolated",\n  "layoutVersion": 5\n}\n']) {
  test(`isolated layout migration is locked and script-free (${metadata.startsWith("{") ? "JSON" : "YAML"})`, (t) => {
    const { root, write } = fixture(t);
    write("settings.json", JSON.stringify({ theme: "dark", npmCommand: ["pnpm"] }));
    write("npm/node_modules/.modules.yaml", metadata);
    const lock = write("npm/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const stub = runner();
    configureNpmCommand(root, stub);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "settings.json"))), { theme: "dark", npmCommand: NPM_COMMAND });
    assert.deepEqual(stub.calls, [["pnpm", [
      "--config.node-linker=hoisted", "install", "--force", "--frozen-lockfile", "--ignore-scripts",
      "--config.auto-install-peers=false", "--config.strict-peer-dependencies=false", "--config.strict-dep-builds=false",
    ], { cwd: path.join(root, "npm"), stdio: "inherit" }]]);
    assert.equal(fs.readFileSync(lock, "utf8"), "lockfileVersion: '9.0'\n");
    // pnpm records the new layout on successful migration; next install must not
    // force a reinstall and erase fork overlays just for configuring the command.
    write("npm/node_modules/.modules.yaml", "nodeLinker: hoisted\n");
    configureNpmCommand(root, stub);
    assert.equal(stub.calls.length, 1);
  });
}

test("an isolated layout without a lockfile refuses before modifying settings", (t) => {
  const { root, write } = fixture(t);
  const settings = write("settings.json", '{"theme":"dark"}\n');
  write("npm/node_modules/.modules.yaml", "nodeLinker: isolated\n");
  const stub = runner();
  assert.throws(() => configureNpmCommand(root, stub), /restore its lockfile/);
  assert.equal(fs.readFileSync(settings, "utf8"), '{"theme":"dark"}\n');
  assert.deepEqual(stub.calls, []);
});

for (const result of [{ status: 1 }, { status: null, signal: "SIGTERM" }, { error: new Error("spawn failed") }]) {
  test(`failed migration stops installation (${result.error?.message ?? result.signal ?? result.status})`, (t) => {
    const { root, write } = fixture(t);
    write("npm/node_modules/.modules.yaml", "nodeLinker: isolated\n");
    write("npm/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    assert.throws(() => configureNpmCommand(root, { run: () => result, log: () => {} }), /migration failed; stop before deploying/);
  });
}

test("invalid settings are not overwritten", (t) => {
  const { root, write } = fixture(t);
  const settings = write("settings.json", "[]\n");
  assert.throws(() => configureNpmCommand(root, runner()), /must contain an object/);
  assert.equal(fs.readFileSync(settings, "utf8"), "[]\n");
});

test("selected actual Pi loader rejects isolated and loads hoisted dependencies", {
  skip: !process.env.PI_TEST_EXTENSION_LOADER && "set PI_TEST_EXTENSION_LOADER to the installed Pi dist/core/extensions/loader.js",
}, async (t) => {
  const { loadExtensions } = await import(pathToFileURL(path.resolve(process.env.PI_TEST_EXTENSION_LOADER)));
  for (const mode of ["isolated", "hoisted"]) {
    const { root, write } = fixture(t);
    const installed = "node_modules/fixture-extension";
    const store = "node_modules/.pnpm/fixture-extension@1/node_modules";
    const pkg = mode === "isolated" ? `${store}/fixture-extension` : installed;
    const dep = mode === "isolated" ? `${store}/fixture-dependency` : "node_modules/fixture-dependency";
    write(`${pkg}/src/index.ts`, 'import value from "fixture-dependency"; export default function (pi) { if (value !== 42) throw new Error("bad dependency"); pi.registerCommand("fixture", { description: "fixture", handler: async () => {} }); }\n');
    write(`${dep}/package.json`, JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" }));
    write(`${dep}/index.js`, "module.exports = 42;\n");
    if (mode === "isolated") fs.symlinkSync(".pnpm/fixture-extension@1/node_modules/fixture-extension", path.join(root, installed));
    const result = await loadExtensions([path.join(root, installed, "src/index.ts")], root);
    assert.equal(result.extensions.length, mode === "hoisted" ? 1 : 0);
    assert.equal(result.errors.length, mode === "hoisted" ? 0 : 1);
    if (mode === "isolated") assert.match(result.errors[0].error, /Cannot find module 'fixture-dependency'/);
  }
});

test("the public extension path loses isolated dependencies but sees hoisted ones", (t) => {
  const { root, write } = fixture(t);
  const publicPackage = path.join(root, "node_modules/fixture-extension");
  const privatePackage = path.join(root, "node_modules/.pnpm/fixture-extension@1/node_modules/fixture-extension");
  const manifest = JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" });
  write("node_modules/.pnpm/fixture-extension@1/node_modules/fixture-extension/src/index.ts", "export default function () {}\n");
  write("node_modules/.pnpm/fixture-extension@1/node_modules/fixture-dependency/package.json", manifest);
  write("node_modules/.pnpm/fixture-extension@1/node_modules/fixture-dependency/index.js", "module.exports = 42;\n");
  fs.symlinkSync(path.relative(path.dirname(publicPackage), privatePackage), publicPackage);
  const publicEntry = path.join(publicPackage, "src/index.ts");
  assert.throws(() => createRequire(publicEntry).resolve("fixture-dependency"), { code: "MODULE_NOT_FOUND" });
  assert.ok(createRequire(fs.realpathSync(publicEntry)).resolve("fixture-dependency"));

  // The hoisted layout has real package directories and root/nested dependencies
  // along the public path. This models the layout, not pnpm's migration engine.
  fs.unlinkSync(publicPackage);
  write("node_modules/fixture-extension/src/index.ts", "export default function () {}\n");
  write("node_modules/fixture-dependency/package.json", manifest);
  const dependency = write("node_modules/fixture-dependency/index.js", "module.exports = 42;\n");
  assert.equal(createRequire(publicEntry).resolve("fixture-dependency"), fs.realpathSync(dependency));
  assert.equal(createRequire(fs.realpathSync(publicEntry)).resolve("fixture-dependency"), fs.realpathSync(dependency));
});
