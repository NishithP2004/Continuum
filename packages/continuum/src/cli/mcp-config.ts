import { resolve } from "node:path";

export function formatMcpConfig(root: string, databasePath: string): string {
  const resolvedRoot = resolve(root);
  const wrapper = resolve(resolvedRoot, "script/run_mcp.sh");
  return [
    "[mcp_servers.continuum]",
    `command = ${JSON.stringify(wrapper)}`,
    "args = []",
    `cwd = ${JSON.stringify(resolvedRoot)}`,
    "enabled_tools = [\"current\", \"timeline\", \"search\", \"resume\", \"diff\", \"graph\"]",
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 30",
    `env = { CONTINUUM_DB = ${JSON.stringify(resolve(databasePath))} }`,
    ""
  ].join("\n");
}
