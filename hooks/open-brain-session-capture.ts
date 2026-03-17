#!/usr/bin/env bun
// SessionEnd hook: captures session knowledge to Open Brain
// Uses mcp2cli for transport/auth -- no raw HTTP
// Fires on: session end
// Silent on all errors -- never blocks session end

export {};

try {
  const input = await Bun.stdin.json();
  const { cwd } = input;
  const project = cwd.split("/").pop() || "unknown";

  // Get recent git log (last 10 commits)
  let commits: string[] = [];
  try {
    const logResult = Bun.spawnSync(
      ["git", "log", "--oneline", "--no-decorate", "-10"],
      { cwd, timeout: 3000 },
    );
    if (logResult.exitCode === 0) {
      commits = logResult.stdout.toString().trim().split("\n").filter(Boolean);
    }
  } catch {
    /* no git or not a repo */
  }

  // Get git diff --stat for changed files
  let diffStat = "";
  try {
    // Check commit count first -- HEAD~1 fails on single-commit repos
    const countResult = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], {
      cwd,
      timeout: 2000,
    });
    const commitCount =
      countResult.exitCode === 0
        ? parseInt(countResult.stdout.toString().trim(), 10)
        : 0;
    const diffArgs =
      commitCount <= 1
        ? ["git", "show", "--stat", "--format=", "HEAD"]
        : ["git", "diff", "--stat", "HEAD~1", "HEAD"];
    const diffResult = Bun.spawnSync(diffArgs, { cwd, timeout: 3000 });
    if (diffResult.exitCode === 0) {
      diffStat = diffResult.stdout.toString().trim();
    }
  } catch {
    /* ignore */
  }

  // Get branch name for tags
  let branch = "";
  try {
    const branchResult = Bun.spawnSync(["git", "branch", "--show-current"], {
      cwd,
      timeout: 2000,
    });
    if (branchResult.exitCode === 0) {
      branch = branchResult.stdout.toString().trim();
    }
  } catch {
    /* ignore */
  }

  // Extract decision commits (feat/fix/refactor/chore/docs/perf)
  const decisionPrefixes =
    /^[a-f0-9]+ (feat|fix|refactor|chore|docs|perf|test)(\(.+\))?:/;
  const decisionCommits = commits.filter((c) => decisionPrefixes.test(c));

  // Build key_decisions from commit messages (strip hash)
  const key_decisions = decisionCommits.map((c) =>
    c.replace(/^[a-f0-9]+ /, ""),
  );

  // Build rich summary
  const summaryParts: string[] = [`Session end capture for ${project}`];
  if (branch) summaryParts.push(`Branch: ${branch}`);
  if (commits.length)
    summaryParts.push(`Last commit: ${commits[0].replace(/^[a-f0-9]+ /, "")}`);
  if (diffStat) summaryParts.push(`\n\nChanged files:\n${diffStat}`);
  const summary = summaryParts.join(". ");

  // Build tags from branch type
  const tags = ["auto-save", "session-end"];
  if (branch) {
    const branchType = branch.split("/")[0];
    if (
      ["feat", "fix", "wip", "chore", "refactor", "docs"].includes(branchType)
    ) {
      tags.push(branchType);
    }
  }

  // Helper to call mcp2cli
  const callOB = (tool: string, params: Record<string, unknown>): boolean => {
    const result = Bun.spawnSync(
      ["mcp2cli", "open-brain", tool, "--params", JSON.stringify(params)],
      { timeout: 12000 },
    );
    if (result.exitCode !== 0) {
      console.error(
        `open-brain ${tool} failed: ${result.stderr.toString().trim()}`,
      );
      return false;
    }
    return true;
  };

  // Save session
  callOB("session_save", {
    summary,
    project,
    tags,
    key_decisions,
    next_steps: [],
  });

  // Log each decision commit
  for (const commit of decisionCommits) {
    const title = commit.replace(/^[a-f0-9]+ /, "");
    callOB("log_decision", {
      title,
      rationale: "Decided during session",
      tags: [project, ...tags],
    });
  }

  // Log a thought summarizing the diff if we have one
  if (diffStat) {
    callOB("log_thought", {
      content: `Files changed in ${project} session:\n\n${diffStat}`,
      tags: [project, "git-diff", "session-end"],
    });
  }
} catch (err) {
  // Log but never block session end
  console.error(`open-brain session-capture hook error: ${err}`);
  process.exit(0);
}
