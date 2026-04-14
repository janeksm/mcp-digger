import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";

const execFile = util.promisify(child_process.execFile);

/** Init a git repo with one commit containing the given files. */
export async function initRepo(
  tmpDir: string,
  files: Record<string, string>,
): Promise<string> {
  const repoDir = path.join(tmpDir, "repo-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(repoDir, { recursive: true });

  await execFile("git", ["init", repoDir]);
  await execFile("git", ["-C", repoDir, "config", "user.email", "test@test.com"]);
  await execFile("git", ["-C", repoDir, "config", "user.name", "Test"]);

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  await execFile("git", ["-C", repoDir, "add", "."]);
  await execFile("git", ["-C", repoDir, "commit", "-m", "initial"]);

  return repoDir;
}

/** Create a bare git repo (cloneable remote) with one commit. */
export async function createBareRepo(
  tmpDir: string,
  files: Record<string, string>,
): Promise<string> {
  const workDir = await initRepo(tmpDir, files);
  const bareDir = path.join(tmpDir, "bare-" + Math.random().toString(36).slice(2) + ".git");
  await execFile("git", ["clone", "--bare", workDir, bareDir]);
  return bareDir;
}
