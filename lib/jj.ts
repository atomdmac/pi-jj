/**
 * jj (Jujutsu) VCS command helpers
 *
 * Wraps common jj operations with proper error handling and typed output.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface JJWorkspace {
  name: string;
  path: string;
  isCurrent: boolean;
}

export interface JJChange {
  changeId: string;
  commitId: string;
  description: string;
  author: string;
  timestamp: string;
  empty: boolean;
}

export interface JJStatus {
  workingCopy: string;
  parentChanges: string[];
  trackedBranches: string[];
  modifiedFiles: string[];
  addedFiles: string[];
  removedFiles: string[];
}

/**
 * Check if jj is installed and get version
 */
export async function jjVersion(pi: ExtensionAPI): Promise<string | null> {
  const result = await pi.exec("jj", ["--version"], { timeout: 5000 });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

/**
 * Check if current directory is inside a jj repository
 */
export async function jjIsRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const result = await pi.exec("jj", ["root"], { cwd, timeout: 5000 });
  return result.code === 0;
}

/**
 * Get the root directory of the jj repository
 */
export async function jjRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const result = await pi.exec("jj", ["root"], { cwd, timeout: 5000 });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

/**
 * List all workspaces in the repository
 * 
 * NOTE: jj doesn't expose workspace paths via templates (WorkspaceRef only has .name() and .target()).
 * For non-current workspaces, we can only guess the path based on naming conventions.
 * The current workspace path is accurate via `jj workspace root`.
 */
export async function jjWorkspaceList(pi: ExtensionAPI, cwd: string): Promise<JJWorkspace[]> {
  // Get workspace names using template (WorkspaceRef only has .name() and .target())
  const template = 'self.name() ++ "\\n"';
  const result = await pi.exec("jj", ["workspace", "list", "-T", template], { cwd, timeout: 10000 });

  if (result.code !== 0) {
    throw new Error(`Failed to list workspaces: ${result.stderr}`);
  }

  const workspaces: JJWorkspace[] = [];
  const names = result.stdout.trim().split("\n").filter(Boolean);

  // Get current workspace path - this is the only path we can know for certain
  const currentResult = await pi.exec("jj", ["workspace", "root"], { cwd, timeout: 5000 });
  const currentPath = currentResult.code === 0 ? currentResult.stdout.trim() : "";

  // Get repo root to guess other workspace paths
  const repoRoot = await jjRoot(pi, cwd);

  for (const name of names) {
    const trimmedName = name.trim();
    
    // For the default workspace, use the repo root
    // For other workspaces, we can only guess - jj doesn't expose paths
    let wsPath: string;
    if (trimmedName === "default" && repoRoot) {
      wsPath = repoRoot;
    } else if (repoRoot) {
      // Best guess: workspaces are siblings with repoName-workspaceName pattern
      const repoName = repoRoot.split("/").pop() || "";
      const parentDir = repoRoot.replace(/\/[^/]+$/, "");
      wsPath = `${parentDir}/${repoName}-${trimmedName}`;
    } else {
      wsPath = trimmedName;
    }

    const isCurrent = wsPath === currentPath || trimmedName === "default" && currentPath === repoRoot;
    workspaces.push({
      name: trimmedName,
      path: isCurrent ? currentPath : wsPath,
      isCurrent,
    });
  }

  return workspaces;
}

/**
 * Create a new workspace
 */
export async function jjWorkspaceAdd(
  pi: ExtensionAPI,
  cwd: string,
  name: string,
  path?: string
): Promise<{ success: boolean; path: string; error?: string }> {
  const args = ["workspace", "add", "--name", name];
  
  // Determine the path - use provided path or default to sibling directory
  const targetPath = path || `../${name}`;
  args.push(targetPath);

  const result = await pi.exec("jj", args, { cwd, timeout: 30000 });

  if (result.code !== 0) {
    return {
      success: false,
      path: targetPath,
      error: result.stderr.trim() || "Unknown error creating workspace",
    };
  }

  // Return the path we passed to jj - resolve to absolute if relative
  // jj doesn't expose workspace paths via templates, so we track it ourselves
  const { resolve } = await import("node:path");
  const resolvedPath = targetPath.startsWith("/") ? targetPath : resolve(cwd, targetPath);

  return {
    success: true,
    path: resolvedPath,
  };
}

/**
 * Forget (remove) a workspace
 */
export async function jjWorkspaceForget(
  pi: ExtensionAPI,
  cwd: string,
  name: string
): Promise<{ success: boolean; error?: string }> {
  const result = await pi.exec("jj", ["workspace", "forget", name], { cwd, timeout: 10000 });

  if (result.code !== 0) {
    return {
      success: false,
      error: result.stderr.trim() || "Unknown error forgetting workspace",
    };
  }

  return { success: true };
}

/**
 * Set the description of the current change
 */
export async function jjDescribe(
  pi: ExtensionAPI,
  cwd: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const result = await pi.exec("jj", ["describe", "-m", message], { cwd, timeout: 10000 });

  if (result.code !== 0) {
    return {
      success: false,
      error: result.stderr.trim() || "Unknown error setting description",
    };
  }

  return { success: true };
}

/**
 * Squash the current change into its parent
 */
export async function jjSquash(
  pi: ExtensionAPI,
  cwd: string
): Promise<{ success: boolean; error?: string }> {
  const result = await pi.exec("jj", ["squash"], { cwd, timeout: 30000 });

  if (result.code !== 0) {
    return {
      success: false,
      error: result.stderr.trim() || "Unknown error squashing",
    };
  }

  return { success: true };
}

/**
 * Create a new change
 */
export async function jjNew(
  pi: ExtensionAPI,
  cwd: string,
  message?: string
): Promise<{ success: boolean; error?: string }> {
  const args = ["new"];
  if (message) {
    args.push("-m", message);
  }

  const result = await pi.exec("jj", args, { cwd, timeout: 10000 });

  if (result.code !== 0) {
    return {
      success: false,
      error: result.stderr.trim() || "Unknown error creating new change",
    };
  }

  return { success: true };
}

/**
 * Get the current change ID
 */
export async function jjCurrentChange(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const result = await pi.exec("jj", ["log", "-r", "@", "-T", "change_id", "--no-graph"], {
    cwd,
    timeout: 5000,
  });

  if (result.code !== 0) return null;
  return result.stdout.trim();
}

/**
 * Get a short log of recent changes
 */
export async function jjLog(
  pi: ExtensionAPI,
  cwd: string,
  limit: number = 10
): Promise<string> {
  const result = await pi.exec("jj", ["log", "-n", String(limit)], { cwd, timeout: 10000 });

  if (result.code !== 0) {
    throw new Error(`Failed to get log: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Get status of the working copy
 */
export async function jjSt(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("jj", ["st"], { cwd, timeout: 10000 });

  if (result.code !== 0) {
    throw new Error(`Failed to get status: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Show diff of current changes
 */
export async function jjDiff(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("jj", ["diff"], { cwd, timeout: 30000 });

  if (result.code !== 0) {
    throw new Error(`Failed to get diff: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Generate a safe workspace name from a task description
 */
export function sanitizeWorkspaceName(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with dashes
    .replace(/^-+|-+$/g, "") // Trim leading/trailing dashes
    .slice(0, 40); // Limit length
}
