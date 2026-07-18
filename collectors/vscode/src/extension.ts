import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { inspectWorkspacePath, sanitizeLabel } from "./privacy";
import { resolveProjectId } from "./project-identity";
import { DurableEventQueue } from "./queue";
import { EventTransport } from "./transport";
import type { NormalizedEventV1 } from "./types";

const TOKEN_KEY = "continuum.localBearerToken";
const SESSION_ID = randomUUID();

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentWorkspace(): vscode.WorkspaceFolder | undefined {
  if (!vscode.workspace.isTrusted) return undefined;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length !== 1) return undefined;
  return folders[0];
}

function captureEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("continuum")
    .get<boolean>("captureEnabled", true);
}

function projectIdFor(workspace: vscode.WorkspaceFolder): string {
  const configured = vscode.workspace
    .getConfiguration("continuum", workspace.uri)
    .get<string>("projectId", "");
  return resolveProjectId(
    workspace.uri.fsPath,
    configured || process.env.CONTINUUM_PROJECT_ID,
  );
}

function eventFor(
  workspace: vscode.WorkspaceFolder,
  eventType: NormalizedEventV1["eventType"],
  title: string,
  attributes: NormalizedEventV1["attributes"],
  privacyRule: string,
): NormalizedEventV1 {
  const occurredAt = new Date().toISOString();
  const projectId = projectIdFor(workspace);
  const event = {
    version: "1" as const,
    id: randomUUID(),
    occurredAt,
    source: "vscode" as const,
    eventType,
    projectId,
    sessionId: SESSION_ID,
    title,
    attributes,
    privacy: {
      classification: "personal" as const,
      rules: [privacyRule, "no-file-contents", "workspace-relative-paths"],
    },
    relevance: {
      decision: "keep" as const,
      reason: "trusted-single-root-workspace",
    },
    confidence: 1,
    dedupeKey: "",
  };
  event.dedupeKey = hash(
    `${event.source}\0${event.eventType}\0${projectId}\0${JSON.stringify(attributes)}\0${occurredAt.slice(0, 16)}`,
  );
  return event;
}

function privacyDropEvent(
  workspace: vscode.WorkspaceFolder,
  rule: string,
): NormalizedEventV1 {
  const occurredAt = new Date().toISOString();
  const projectId = projectIdFor(workspace);
  return {
    version: "1",
    id: randomUUID(),
    occurredAt,
    source: "vscode",
    eventType: "privacy.drop.aggregate",
    projectId,
    sessionId: SESSION_ID,
    title: "Sensitive editor event dropped",
    attributes: { rule, count: 1 },
    privacy: {
      classification: "public",
      rules: ["aggregate-only", rule],
    },
    relevance: {
      decision: "keep",
      reason: "privacy-audit-counter",
    },
    confidence: 1,
    dedupeKey: hash(`vscode\0drop\0${projectId}\0${rule}\0${occurredAt}`),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const queue = new DurableEventQueue(
    vscode.Uri.joinPath(context.globalStorageUri, "sanitized-events.json").fsPath,
  );
  const transport = new EventTransport(
    queue,
    () =>
      vscode.workspace
        .getConfiguration("continuum")
        .get<string>("endpoint", "http://127.0.0.1:43117"),
    async () =>
      (await context.secrets.get(TOKEN_KEY)) || process.env.CONTINUUM_TOKEN,
  );

  const reportFailure = (error: unknown): void => {
    console.error("Continuum collector retained a sanitized event for retry:", error);
  };

  const submit = (event: NormalizedEventV1): void => {
    void transport.submit(event).catch(reportFailure);
  };

  const collectWorkspaceFocus = (): void => {
    if (!captureEnabled() || !vscode.window.state.focused) return;
    const workspace = currentWorkspace();
    if (!workspace) return;
    submit(
      eventFor(
        workspace,
        "workspace.focused",
        `Focused ${sanitizeLabel(workspace.name)}`,
        { workspace: sanitizeLabel(workspace.name) },
        "workspace-name-only",
      ),
    );
  };

  const collectFile = (
    document: vscode.TextDocument,
    eventType: "file.activated" | "file.saved",
  ): void => {
    if (!captureEnabled() || document.uri.scheme !== "file") return;
    const workspace = currentWorkspace();
    if (!workspace) return;
    const decision = inspectWorkspacePath(
      workspace.uri.fsPath,
      document.uri.fsPath,
    );
    if (!decision.keep || !decision.relativePath) {
      if (decision.classification === "confidential") {
        submit(privacyDropEvent(workspace, decision.reason));
      }
      return;
    }
    const relativePath = decision.relativePath;
    const languageId = sanitizeLabel(document.languageId, "unknown");
    submit(
      eventFor(
        workspace,
        eventType,
        `${eventType === "file.saved" ? "Saved" : "Opened"} ${path.posix.basename(relativePath)}`,
        { path: relativePath, languageId },
        decision.reason,
      ),
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("continuum.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Paste the bearer token shown by the local Continuum engine",
        password: true,
        ignoreFocusOut: true,
      });
      if (token?.trim()) {
        await context.secrets.store(TOKEN_KEY, token.trim());
        void transport.flush().catch(reportFailure);
        void vscode.window.showInformationMessage("Continuum connected locally.");
      }
    }),
    vscode.commands.registerCommand("continuum.flushQueue", async () => {
      await transport.flush();
      void vscode.window.showInformationMessage("Continuum retry complete.");
    }),
    vscode.window.onDidChangeWindowState(collectWorkspaceFocus),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) collectFile(editor.document, "file.activated");
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      collectFile(document, "file.saved");
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(collectWorkspaceFocus),
  );

  collectWorkspaceFocus();
  if (vscode.window.activeTextEditor) {
    collectFile(vscode.window.activeTextEditor.document, "file.activated");
  }
  void transport.flush().catch(reportFailure);
}

export function deactivate(): void {}
