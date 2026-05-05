import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = {}): CommandResult {
  const result = spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 200,
  });

  return {
    command,
    cwd,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function assertCleanEnough(repoPath: string): void {
  const status = runCommand("git status --short", repoPath);
  if (status.exitCode !== 0) {
    throw new Error(status.stderr || status.stdout);
  }
}

export function assertCleanWorktree(repoPath: string): void {
  const status = runCommand("git status --short", repoPath);
  if (status.exitCode !== 0) {
    throw new Error(status.stderr || status.stdout);
  }
  if (status.stdout.trim()) {
    throw new Error(`Refusing to operate on dirty worktree ${repoPath}:\n${status.stdout}`);
  }
}

export function createWorktree(targetRepoPath: string, branch: string, baseBranch: string): string {
  const worktreesDir = join(targetRepoPath, ".worktrees");
  mkdirSync(worktreesDir, { recursive: true });

  const safeName = branch.replaceAll("/", "-");
  const worktreePath = join(worktreesDir, safeName);
  if (existsSync(worktreePath)) return worktreePath;

  const branchExists = runCommand(`git show-ref --verify --quiet "refs/heads/${branch}"`, targetRepoPath);
  const command =
    branchExists.exitCode === 0
      ? `git worktree add ".worktrees/${safeName}" "${branch}"`
      : `git worktree add ".worktrees/${safeName}" -b "${branch}" "${baseBranch}"`;
  const result = runCommand(
    command,
    targetRepoPath,
    { GIT_LFS_SKIP_SMUDGE: "1" },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }

  return worktreePath;
}

export function currentHead(repoPath: string): string {
  const result = runCommand("git rev-parse --short HEAD", repoPath);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

export function refHead(repoPath: string, ref: string): string | undefined {
  const result = runCommand(`git rev-parse --short "${ref}"`, repoPath);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim();
}
