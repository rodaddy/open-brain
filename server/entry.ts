/**
 * The container entrypoint (issue 1594, D4): one image, the role picked by
 * `OPEN_BRAIN_ROLE`.
 *
 *   unset | "server"  -> exactly what `node server/main.ts` runs (`main()`)
 *   "nats-worker"     -> exactly what `node scripts/run-nats-worker.ts` runs
 *   anything else     -> one stderr line naming the value and the allowed set,
 *                        exit 2. Nothing is adjusted silently: a typo never
 *                        falls back to the server.
 *
 * Each role is loaded with a dynamic import so the other role's modules (and
 * their import-time side effects, e.g. scripts/settings.ts registrations) are
 * never loaded. Both direct entrypoints keep their own `import.meta.main`
 * guards, so the Mac launchd services that run them are unchanged.
 */

export const OPEN_BRAIN_ROLES = ["server", "nats-worker"] as const;
export type OpenBrainRole = (typeof OPEN_BRAIN_ROLES)[number];

export type RoleStarters = Record<OpenBrainRole, () => Promise<void>>;

export const defaultRoleStarters: RoleStarters = {
  server: async () => {
    const { main } = await import("./main.ts");
    await main();
  },
  "nats-worker": async () => {
    const { runNatsWorkerMain } = await import("../scripts/run-nats-worker.ts");
    await runNatsWorkerMain();
  },
};

export interface RunEntryOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly starters?: RoleStarters;
  readonly stderr?: (line: string) => void;
  readonly exit?: (code: number) => void;
}

function isRole(value: string): value is OpenBrainRole {
  return (OPEN_BRAIN_ROLES as readonly string[]).includes(value);
}

export async function runEntry(options: RunEntryOptions): Promise<void> {
  const starters = options.starters ?? defaultRoleStarters;
  const stderr =
    options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const raw = options.env.OPEN_BRAIN_ROLE;
  const role = raw === undefined ? "server" : raw;
  if (!isRole(role)) {
    stderr(
      `open-brain entry: unknown OPEN_BRAIN_ROLE ${JSON.stringify(role)}; allowed: ${OPEN_BRAIN_ROLES.join(", ")} (unset means server)`,
    );
    exit(2);
    return;
  }
  await starters[role]();
}

if (import.meta.main) {
  // The environment is read only through the config module (the lint door).
  const { openBrainRoleEnvironment } = await import("./config.ts");
  await runEntry({ env: openBrainRoleEnvironment() });
}
