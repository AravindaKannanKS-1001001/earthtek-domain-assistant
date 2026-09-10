import { createDbBasedMCPConfigsStorage } from "./db-mcp-config-storage";
import { createFileBasedMCPConfigsStorage } from "./fb-mcp-config-storage";
import {
  createMCPClientsManager,
  type MCPClientsManager,
} from "./create-mcp-clients-manager";
import { FILE_BASED_MCP_CONFIG } from "lib/const";
declare global {
  // eslint-disable-next-line no-var
  var __mcpClientsManager__: MCPClientsManager;
}

if (!globalThis.__mcpClientsManager__) {
  // Choose the appropriate storage implementation based on environment
  // NOTE: FILE_BASED_MCP_CONFIG is deprecated and will be removed in a future version.
  const storage = FILE_BASED_MCP_CONFIG
    ? createFileBasedMCPConfigsStorage()
    : createDbBasedMCPConfigsStorage();
  globalThis.__mcpClientsManager__ = createMCPClientsManager(storage);
}

/**
 * Env-driven MCP server (EarthTekniks domain assistant).
 * Registered in-memory on init — credentials stay server-side, never persisted
 * to the DB and never sent to the browser.
 */
const ENV_MCP_ID = "env-earthtek-mcp";

const registerEnvMcpServer = async (manager: MCPClientsManager) => {
  const url = process.env.MCP_SERVER_URL?.trim();
  if (!url) return;
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  const existing = await manager.getClient(ENV_MCP_ID).catch(() => null);
  if (existing) return;
  await manager
    .addClient(ENV_MCP_ID, process.env.MCP_SERVER_NAME?.trim() || "earthtek", {
      url,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    .catch((err) => {
      globalThis.console.error("Failed to register env MCP server:", err);
    });
};

export const initMCPManager = async () => {
  await globalThis.__mcpClientsManager__.init();
  await registerEnvMcpServer(globalThis.__mcpClientsManager__);
};

export const mcpClientsManager = globalThis.__mcpClientsManager__;
