import { readFileSync } from "node:fs";

import { forgeListPaged, forgePost } from "./forge-api.ts";

interface ForgePullSummary {
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}

interface PublishArgs {
  head: string;
  base: string;
  title: string;
  body: string;
}

interface CliArgs {
  head: string;
  base: string;
  title: string;
  bodyFile: string;
}

export interface ForgePrApi {
  listOpen(path: string): Promise<ForgePullSummary[]>;
  create(path: string, body: unknown): Promise<ForgePullSummary>;
}

const REQUIRED_FLAGS = ["--head", "--body-file", "--title", "--base"] as const;
const PROTECTED_HEADS = new Set([
  "main",
  "master",
  "refs/heads/main",
  "refs/heads/master",
]);

function flagValues(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!REQUIRED_FLAGS.includes(flag as (typeof REQUIRED_FLAGS)[number])) {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (!value) throw new Error(`missing value for ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  return values;
}

function requiredValue(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`missing required argument: ${flag}`);
  return value;
}

export function parseForgePrCreateArgs(argv: string[]): CliArgs {
  const values = flagValues(argv);
  const head = requiredValue(values, "--head");
  if (PROTECTED_HEADS.has(head)) throw new Error(`refusing protected head: ${head}`);
  const base = requiredValue(values, "--base");
  if (base !== "main") throw new Error(`refusing unsupported base: ${base}`);
  return {
    head,
    bodyFile: requiredValue(values, "--body-file"),
    title: requiredValue(values, "--title"),
    base,
  };
}

const liveApi: ForgePrApi = {
  listOpen: (path) => forgeListPaged<ForgePullSummary>(path, (pull) => pull.number),
  create: (path, body) => forgePost<ForgePullSummary>(path, body),
};

export async function publishForgePullRequest(
  args: PublishArgs,
  api: ForgePrApi = liveApi,
): Promise<ForgePullSummary> {
  const findMatches = async () => {
    const pulls = await api.listOpen("/pulls?state=open&limit=50");
    return pulls.filter(
      (pull) =>
        pull.head.ref === args.head &&
        pull.base.ref === args.base &&
        pull.head.repo.full_name === pull.base.repo.full_name,
    );
  };
  const matches = await findMatches();
  if (matches.length > 1)
    throw new Error(`multiple exact open PRs found for head ${args.head}`);
  const existing = matches[0];
  if (existing) return existing;
  try {
    return await api.create("/pulls", args);
  } catch (error: unknown) {
    const concurrent = await findMatches();
    if (concurrent.length === 1) return concurrent[0] as ForgePullSummary;
    throw error;
  }
}

async function main(): Promise<void> {
  const cli = parseForgePrCreateArgs(process.argv.slice(2));
  const pull = await publishForgePullRequest({
    head: cli.head,
    base: cli.base,
    title: cli.title,
    body: readFileSync(cli.bodyFile, "utf8"),
  });
  process.stdout.write(
    `${JSON.stringify({
      number: pull.number,
      url: pull.html_url,
      state: pull.state,
      draft: pull.draft,
      head: pull.head,
      base: pull.base,
    })}\n`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Forgejo PR publication failed",
    );
    process.exitCode = 1;
  });
}
