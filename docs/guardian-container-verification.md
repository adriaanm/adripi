# Guardian compatible-runtime verification in a VM

## Verified result

Operator-authorized Apple `container` **1.2.2**, Linux/arm64, **Node v24.22.2**:

| Gate | Result |
|---|---|
| Standalone real Pi 1.0 CLI/HTTP JSON no-session test | **1 pass, zero skips**; status, nested codemode/bash assessments and fixed-rule denial |
| Complete Guardian suite, including HTTP headless | **215 pass / 215 total, zero failures/skips**, 9.81s (current-source refresh) |
| Guardian and pi-sbx typechecks | Pass |
| Package manifests and selected/secondary locks | Hashes unchanged before/after provisioning and tests |

Latest tested source: `1e935e6b680d629a0a1abd6185e5ee67f0ed1617`.
Source archive SHA-256:
`3c56af8a26c0ef5a161ea5ba006abf99f424d057bb18d6d83e7ade47637f53ad`.
The exact tested guest driver is preserved as
[`scripts/verify-guardian-vm.mjs`](../scripts/verify-guardian-vm.mjs).
Current ignored evidence: `.local/guardian-container/source-1e935e6b680d-results/`
(`results.json`, `headless.log`, `guardian-full.log`, both typecheck logs), the
sibling `source-1e935e6b680d-inspect.json` and `source-1e935e6b680d-input/` snapshot.
Inspection confirms the pinned image, arm64, user `node`, four CPUs/4GiB, the sole
read-only curated input mount, no published ports/sockets and no host environment.
Logs were copied before stopping/deleting only `adripi-guardian-node24-1e935e6`;
`container list` is empty afterward. All provisioning/test steps pass and all
seven tracked manifest/lock hashes remain unchanged.

Historical evidence remains under `recipe/` and `attempt2/`: source
`b81bd669f958a41842f83481740f8f59f01ae317`, archive
`5faf0eb3695d77b892dbfe6b87240b6f9bb43e275854e5aa09d81e4a9cfd35db`,
**178/178**, 9.32s/9.53s. The unchanged driver refuses an existing guest work
directory before altering evidence; that historical duplicate-invocation negative
is retained in `recipe/driver-reentry.log`.

The official image is pinned by OCI index digest:

```text
docker.io/library/node@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413
```

Runs explicitly select `linux/arm64`; its variant digest is
`sha256:704c5d1cfedaa1afc8ae31f6f6a412ee5fbf6e79438944d6c818b0c4f46f6f6b`.
The initial unqualified image pull fetched several architectures; avoid that
unnecessary disk/network use on subsequent pulls.

## Scope and dependency provisioning

The VM ran as guest UID 1000, with four CPUs and 4GiB RAM. The only host mount
was a **read-only curated input directory** containing a tracked-source Git
archive, the driver and snapshot metadata. Dependency installs, caches, synthetic
HOME/agent directory, fake-provider sessions and outputs stayed in the guest.
No host agent directory, credentials, live configs, audits, SSH socket or host
Node modules were mounted; no host environment forwarding or port publishing.
Public image/package downloads and local synthetic HTTP tests used networking;
these are not live-provider performance or billing measurements.

The guest driver pins child `PATH` to its own Node directory and asserts that a
spawned `node` has the same executable/version as the parent. Thus the real CLI
shebang and managed reviewer use **Node24**, not the host's Node26. The SDKs
remain **Guardian1.0.0 / pi-sbx0.84.4 / subagents1.2.0**. It installs pnpm12.15.0
only in guest tooling, uses existing Guardian/pi-sbx **frozen pnpm locks**, and
`npm ci --ignore-scripts --no-audit --no-fund` for subagents. Install scripts are
disabled throughout; manifests and lock files are not regenerated.

The first attempt stopped **before tests**: pi-sbx's secondary npm lock is stale
against its manifest (pi-tui0.84.4 vs1.4.0 and typebox1.3.7 vs1.4.2, with related
transitive mismatches). Its pnpm lock matches both declared versions and the
existing host `.pnpm` graph. The successful retry used that existing frozen lock,
not a relaxed install or dependency upgrade. Todo #31 tracks reconciliation of
the stale npm lock separately. First-attempt console/provenance are retained in
`.local/guardian-container/attempt1-*`.

## Reproduce after separate VM authorization

This is a verification recipe, **not standing host permission or deployment
authorization**. Use an existing approved `container` service; stop/report a
service/admission failure rather than substituting another daemon or runner.
Review the tracked archive before mounting: no live workspace `.pi`, `.local`,
installed `node_modules` or host data may enter it. The current archive's sole
matching tracked path is the reviewed synthetic example
`forks/pi-subagents/examples/typed-gate/.pi/agents/classifier.md` (a text external
classifier definition, not policy/credentials). Do not mount the whole workspace/home.
Use fresh container/output names; do not delete another session's container.

From the repository root, stage the current committed source and driver:

```sh
mkdir -p .local/guardian-container/input
cp scripts/verify-guardian-vm.mjs .local/guardian-container/input/run.mjs
git archive --format=tar --output=.local/guardian-container/input/source.tar HEAD
node --input-type=module -e '
import fs from "node:fs";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
const p=".local/guardian-container/input/";
const hash=f=>createHash("sha256").update(fs.readFileSync(p+f)).digest("hex");
fs.writeFileSync(p+"snapshot.json",JSON.stringify({
  commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
  archiveSha256:hash("source.tar"),runnerSha256:hash("run.mjs"),
  image:"docker.io/library/node@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413",
  platform:"linux/arm64",expectedNode:"v24.22.2"
},null,2));'
```

Start a task-owned VM, then execute the test driver synchronously. Keeping its
initial process alive allows `container copy` to retrieve logs: CLI1.2.2 refuses
copying from a stopped container. Replace `SOURCE_INPUT_ABSOLUTE_PATH` with the
literal absolute input directory; inline host exceptions, if needed, must review
the exact eligible command rather than a shell wrapper.

```sh
container run --detach --name adripi-guardian-node24-verify --platform linux/arm64 --cpus 4 --memory 4G --user node --workdir /tmp --mount type=bind,source=SOURCE_INPUT_ABSOLUTE_PATH,target=/input,readonly docker.io/library/node@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413 sleep infinity
container exec adripi-guardian-node24-verify node /input/run.mjs
```

The driver has per-command deadlines and retains logs/results for failed steps.
Inspect both test summaries (especially HTTP headless **zero skips**) rather
than equating provisioning success with test success. If execution times out,
settle the owned VM/process lifetime and preserve partial logs before retrying.
Snapshot hashes are provenance, not a permission/child-authority store.

Copy logs **before** stopping, even on test failure; then remove only that owned
VM. Do not prune images or other containers globally.

```sh
container copy adripi-guardian-node24-verify:/tmp/adripi-verification/output .local/guardian-container/results
container stop adripi-guardian-node24-verify
container delete adripi-guardian-node24-verify
```

All task-owned VMs were stopped/deleted after evidence extraction; the
public Node image remains cached. No live Pi/Node install, configuration edit,
Guardian toggle, restart, deployment or push occurred.

## Acceptance boundary

Todos **#30** (compatible test infrastructure) and **#4** (compatible-runtime
full CLI/HTTP source integration) are closed. The host **Node26.6.0 macOS native
assertion is not fixed or certified** by this Linux result. The historical
Node26 failure remains a useful platform-specific caveat, not a reason to repeat
that crash or silently switch the live runtime.

The current-source refresh includes the real consumer source/unit changes through
`1e935e6`, not merely the older178-test baseline. It does not extend the separate
combined SDK/IPC composition to actual OS or full detached-launch verification.

Still separate: **#14** full production child wiring acceptance; **#29/#28** authorized
deployment/restart, loaded identities and actual broker lifecycle; **#15** actual
OS/native/descendant/Git containment; **#24** live accounting/provider evidence;
**#25** representative latency and total-spending measurements, including failed
reviews/retries/summaries. Green source/fixture tests do not establish any of them.
