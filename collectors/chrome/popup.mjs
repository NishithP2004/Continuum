import { normalizeAllowlist, sanitizeProjectId } from "./privacy.mjs";

const CONFIG_KEY = "continuumCollectorConfigV1";
const TOKEN_KEY = "continuumBearerToken";
const ENDPOINT_ORIGINS = [
  "http://127.0.0.1:43117/*",
  "http://localhost:43117/*",
];

const project = document.querySelector("#project");
const allowlist = document.querySelector("#allowlist");
const token = document.querySelector("#token");
const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");

async function load() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const config = stored[CONFIG_KEY] ?? {};
  project.value = sanitizeProjectId(config.projectId);
  allowlist.value = normalizeAllowlist(config.allowlist).join("\n");
  enabled.checked = config.enabled === true;
  const session = await chrome.storage.session.get(TOKEN_KEY);
  token.value = session[TOKEN_KEY] ?? "";
}

document.querySelector("#save").addEventListener("click", async () => {
  const projectId = sanitizeProjectId(project.value);
  if (!projectId) {
    status.textContent = "Project ID is required. Copy it from `npm run --silent project-id -- /path/to/repository`.";
    return;
  }
  status.textContent = "Requesting local permissions…";
  const granted = await chrome.permissions.request({
    permissions: ["tabs"],
    origins: ENDPOINT_ORIGINS,
  });
  if (!granted) {
    status.textContent = "Tabs and local-engine permissions are required.";
    return;
  }
  const config = {
    projectId,
    allowlist: normalizeAllowlist(allowlist.value),
    enabled: enabled.checked,
  };
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
  if (token.value.trim()) {
    await chrome.storage.session.set({ [TOKEN_KEY]: token.value.trim() });
  } else {
    await chrome.storage.session.remove(TOKEN_KEY);
  }
  await chrome.runtime.sendMessage({ type: "continuum.capture-now" });
  status.textContent = config.enabled
    ? "Connected. Only allowlisted foreground tabs are captured."
    : "Saved with capture paused.";
});

void load();
