const connection = document.querySelector("#connection");
const project = document.querySelector("#project");
const projectHelp = document.querySelector("#project-help");
const enabled = document.querySelector("#enabled");
const pair = document.querySelector("#pair");
const capture = document.querySelector("#capture");
const status = document.querySelector("#status");

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "continuum.status" });
  enabled.checked = state?.config?.enabled !== false;
  pair.hidden = state?.paired === true;
  capture.disabled = !state?.paired || !state?.lease;
  connection.textContent = state?.paired ? "Paired with the local engine" : state?.pairing?.status === "pending" ? "Waiting for approval in Continuum" : "Not paired";
  if (state?.lease) {
    project.textContent = state.lease.projectName;
    projectHelp.textContent = `Detected from ${state.lease.source}; expires ${new Date(state.lease.expiresAt).toLocaleTimeString()}.`;
  } else {
    project.textContent = "Not detected";
    projectHelp.textContent = "Open a project in VS Code or a Continuum-enabled terminal.";
  }
  if (state?.paired && (state?.policy?.allowedDomains?.length ?? 0) === 0) status.textContent = "Add allowed domains in Continuum → Privacy.";
}

pair.addEventListener("click", async () => {
  status.textContent = "Creating a secure local pairing request…";
  const result = await chrome.runtime.sendMessage({ type: "continuum.pair" });
  status.textContent = result?.status === "paired" ? "Paired." : "Approve this request in Continuum, then reopen this popup.";
  await refresh();
});
capture.addEventListener("click", async () => {
  status.textContent = "Checking policy and active project…";
  await chrome.runtime.sendMessage({ type: "continuum.capture-now" });
  status.textContent = "Current allowed tab captured.";
  await refresh();
});
enabled.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "continuum.set-enabled", enabled: enabled.checked });
  status.textContent = enabled.checked ? "Capture enabled." : "Capture paused for Chrome.";
});

void refresh().catch(() => { connection.textContent = "Continuum engine is offline"; });
