/**
 * Ready-made settings for well-known MCP servers, so a replay can answer their read-only tools for real:
 *
 *   servers:
 *     fs:  { preset: filesystem, root: ./docs }
 *     git: { preset: git, root: . }
 *     web: { preset: fetch }                 # recorded answers only, unless openWorld: true
 *
 * Each preset pins a server version we checked, starts it confined to `root`, and marks only the tools that cannot
 * change anything as live. Tools that write (write_file, git_commit, ...) are left out, so a replay never runs them:
 * an unrecorded write is unreplayable, as before. The lists come from each server's own tool list; a server's
 * readOnlyHint is a claim by the server, so presets are reviewed by hand rather than trusted from the hints.
 */

export const PRESET_NAMES = ["filesystem", "git", "fetch"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

interface Preset {
  /** The command that starts the pinned server, given its root folder. */
  command(root: string): string[];
  /** Tools that only read, and stay inside `root`. */
  readTools: string[];
  /** Tools that change things. They are never live, even if the config marks them read-only. */
  writeTools: string[];
  /** Tools that only read but reach outside the machine (the web), so they go live only with openWorld: true. */
  openWorldTools?: string[];
  /** Whether the preset needs a root folder at all. */
  usesRoot: boolean;
  /** Where to install the server, for error messages. */
  install: string;
}

/**
 * Only the top-level package is pinned: npx and uvx fetch it, and its unlocked dependencies, from the registry when
 * a replay first needs the server. For CI, install the server yourself and set `command`.
 *
 * Versions checked on Nov 26, 2026: path escapes (`..`, absolute paths, symlinks) are refused by the filesystem
 * server, and the git server refuses repositories outside --repository and arguments starting with "-" (older
 * releases let `--output=` through git_diff and git_show, which writes files).
 */
export const PRESET_VERSIONS = {
  filesystem: "@modelcontextprotocol/server-filesystem@2.4.0",
  git: "mcp-server-git@2026.11.18",
  fetch: "mcp-server-fetch@2026.11.18",
} as const;

export const PRESETS: Record<PresetName, Preset> = {
  filesystem: {
    // --read-only makes the server leave its write tools out entirely, a second guard beside the tool list.
    command: (root) => ["npx", "-y", PRESET_VERSIONS.filesystem, "--read-only", "--", root],
    readTools: [
      "read_file",
      "read_text_file",
      "read_media_file",
      "read_multiple_files",
      "list_directory",
      "list_directory_with_sizes",
      "directory_tree",
      "search_files",
      "get_file_info",
      "list_allowed_directories",
    ],
    writeTools: ["write_file", "append_file", "edit_file", "create_directory", "move_file", "copy_file"],
    usesRoot: true,
    install: "Node.js with npx",
  },
  git: {
    command: (root) => ["uvx", PRESET_VERSIONS.git, "--repository", root],
    readTools: [
      "git_status",
      "git_diff_unstaged",
      "git_diff_staged",
      "git_diff",
      "git_log",
      "git_show",
      "git_branch",
      "git_remote",
    ],
    writeTools: ["git_commit", "git_add", "git_reset", "git_create_branch", "git_checkout", "git_merge"],
    usesRoot: true,
    install: "uv (https://docs.astral.sh/uv/)",
  },
  fetch: {
    command: () => ["uvx", PRESET_VERSIONS.fetch],
    readTools: [],
    writeTools: [],
    openWorldTools: ["fetch"],
    usesRoot: false,
    install: "uv (https://docs.astral.sh/uv/)",
  },
};

export interface PresetServer {
  preset: PresetName;
  root?: string | undefined;
  openWorld?: boolean | undefined;
  toolPrefix?: string | undefined;
  command?: string[] | undefined;
}

/** The tools a preset makes live, as the model names them (`mcp__<server>__<tool>` unless toolPrefix says else). */
export function presetTools(serverName: string, s: PresetServer): { name: string; mcpName: string }[] {
  const p = PRESETS[s.preset];
  const prefix = s.toolPrefix ?? `mcp__${serverName}__`;
  const names = [...p.readTools, ...(s.openWorld ? (p.openWorldTools ?? []) : [])];
  return names.map((t) => ({ name: `${prefix}${t}`, mcpName: t }));
}

/** A preset server answers a call with this when the path or repository is outside its root. */
export const OUTSIDE_ROOT = /outside (the )?allowed (directories|repository)|symlink target outside/i;
