# Parked — dev#98 hook-env crossing suite (2026-08-27)

Status: PARKED, WRITTEN and incomplete. Pulled out of the local-only branch
`lane/dev98-hook-env-crossing` (commit 0e5fb0c8, checkpoint of 2026-08-2x) on the Mac
checkout before that branch was retired. The file it adds,
`scripts/setup-client-hook-env.test.ts` (130 lines), fails at line 326 on
`origin/main` (`bun run test:isolated` -> 1 fail), so it cannot ride a branch through
the pre-push gate until it is finished. Resume by applying the patch below on a
branch from `origin/main`, making it pass, and deleting this file in the same PR.

```diff
diff --git a/scripts/setup-client-hook-env.test.ts b/scripts/setup-client-hook-env.test.ts
index a850bcad..82b570a7 100644
--- a/scripts/setup-client-hook-env.test.ts
+++ b/scripts/setup-client-hook-env.test.ts
@@ -298,3 +298,133 @@ describe("setup-client hook env-file normalization", () => {
     expect(result.stderr).toContain("Refusing to guess an insertion point");
   });
 });
+
+// --- the crossing itself (rodaddy/development#98) --------------------------
+//
+// The wrapper's `exec env -i` allowlist is the boundary every hook variable has
+// to survive. Until this suite existed, a variable missing from that list was
+// dropped with exit 0 and no stderr -- five measured incidents, the last being
+// CONTEXT_BUDGET_NAG=300000 read correctly from settings.json and then
+// vanishing before the gate saw it (#77). These tests drive the REAL wrapper
+// text setup-client.sh emits, so a future edit to the list fails loudly here
+// instead of quietly on a client.
+
+/** The variables the wrapper claims to hand the hook, read from its own list. */
+function passedVariables(wrapperSource: string): string[] {
+  const execIndex = wrapperSource.indexOf("exec env -i");
+  if (execIndex < 0) {
+    throw new Error("wrapper has no `exec env -i` list to read");
+  }
+
+  return [
+    ...wrapperSource
+      .slice(execIndex)
+      .matchAll(/^\s{2}([A-Z0-9_]+)="\$\{\1:-\}"\s*\\$/gm),
+  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
+}
+
+const installedWrapper = readFileSync(
+  join(repoRoot, "scripts/openbrain-hook-env"),
+  "utf8",
+);
+
+describe("openbrain-hook-env variable crossing", () => {
+  const declared = passedVariables(installedWrapper);
+
+  it("declares the variables the hooks depend on", () => {
+    // A guard on the guard: an empty parse would make every case below vacuous.
+    expect(declared).toContain("OPENBRAIN_BASE_URL");
+    expect(declared).toContain("OPENBRAIN_TOKEN");
+    expect(declared.length).toBeGreaterThanOrEqual(4);
+  });
+
+  for (const variable of declared) {
+    it(`passes ${variable} through to the child`, () => {
+      const home = fixtureDirectory(`crossing-${variable.toLowerCase()}`);
+      const envDirectory = join(home, ".local/share/openbrain-memory/env");
+      const wrapperPath = createWrapper(envDirectory, installedWrapper);
+      writeFileSync(
+        join(envDirectory, "claudex-observation.env"),
+        `${variable}=ob-crossing-probe\n`,
+      );
+
+      const result = spawnSync(wrapperPath, ["/usr/bin/env"], {
+        encoding: "utf8",
+        env: { HOME: home, PATH: "/usr/bin:/bin" },
+      });
+
+      expect(result.status).toBe(0);
+      expect(result.stdout).toContain(`${variable}=ob-crossing-probe\n`);
+    });
+  }
+
+  it("warns on stderr when it strips a variable the caller set", () => {
+    const home = fixtureDirectory("crossing-stripped");
+    const envDirectory = join(home, ".local/share/openbrain-memory/env");
+    const wrapperPath = createWrapper(envDirectory, installedWrapper);
+    writeFileSync(
+      join(envDirectory, "claudex-observation.env"),
+      "OPENBRAIN_BASE_URL=http://strip.invalid\n",
+    );
+
+    const result = spawnSync(wrapperPath, ["/usr/bin/env"], {
+      encoding: "utf8",
+      env: {
+        HOME: home,
+        PATH: "/usr/bin:/bin",
+        CONTEXT_BUDGET_NAG: "300000",
+        OPENBRAIN_NOT_A_SETTING: "1",
+      },
+    });
+
+    // The strip itself is still correct -- the Python config rejects unknown
+    // OPENBRAIN_* names -- but it must no longer be SILENT.
+    expect(result.status).toBe(0);
+    expect(result.stdout).not.toContain("CONTEXT_BUDGET_NAG");
+    expect(result.stderr).toContain("openbrain-hook-env: WARNING --");
+    expect(result.stderr).toContain("CONTEXT_BUDGET_NAG");
+    expect(result.stderr).toContain("OPENBRAIN_NOT_A_SETTING");
+    expect(result.stderr).toContain("OPENBRAIN_HOOK_ENV_WARN=0");
+  });
+
+  it("stays silent when the caller sets nothing the wrapper drops", () => {
+    const home = fixtureDirectory("crossing-clean");
+    const envDirectory = join(home, ".local/share/openbrain-memory/env");
+    const wrapperPath = createWrapper(envDirectory, installedWrapper);
+    writeFileSync(
+      join(envDirectory, "claudex-observation.env"),
+      "OPENBRAIN_BASE_URL=http://clean.invalid\n",
+    );
+
+    const result = spawnSync(wrapperPath, ["/usr/bin/env"], {
+      encoding: "utf8",
+      env: { HOME: home, PATH: "/usr/bin:/bin" },
+    });
+
+    expect(result.status).toBe(0);
+    expect(result.stderr).toBe("");
+  });
+
+  it("honors the OPENBRAIN_HOOK_ENV_WARN=0 opt-out", () => {
+    const home = fixtureDirectory("crossing-optout");
+    const envDirectory = join(home, ".local/share/openbrain-memory/env");
+    const wrapperPath = createWrapper(envDirectory, installedWrapper);
+    writeFileSync(
+      join(envDirectory, "claudex-observation.env"),
+      "OPENBRAIN_BASE_URL=http://optout.invalid\n",
+    );
+
+    const result = spawnSync(wrapperPath, ["/usr/bin/env"], {
+      encoding: "utf8",
+      env: {
+        HOME: home,
+        PATH: "/usr/bin:/bin",
+        CONTEXT_BUDGET_NAG: "300000",
+        OPENBRAIN_HOOK_ENV_WARN: "0",
+      },
+    });
+
+    expect(result.status).toBe(0);
+    expect(result.stderr).toBe("");
+  });
+});
```
