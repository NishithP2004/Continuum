import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { inspectWorkspacePath, sanitizeLabel } from "./privacy";
import {
  hybridLogicalClock,
  resolveDeviceId,
  resolveProjectIdentity,
  type ProjectIdentity,
} from "./project-identity";
import { DurableEventQueue } from "./queue";
import { PrivacyPolicyCache } from "./policy";
import { EventTransport } from "./transport";
import type { NormalizedEventV2, NormalizedEventV2Draft } from "./types";

const TOKEN_KEY = "continuum.localBearerToken";
const SESSION_ID = randomUUID();
const PROJECT_IDENTITIES = new Map<string, ProjectIdentity>();

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

function projectIdentityFor(workspace: vscode.WorkspaceFolder): ProjectIdentity {
  const configured = vscode.workspace
    .getConfiguration("continuum", workspace.uri)
    .get<string>("projectId", "");
  const override = configured || process.env.CONTINUUM_PROJECT_ID || "";
  const cacheKey = `${workspace.uri.fsPath}\0${override}`;
  const cached = PROJECT_IDENTITIES.get(cacheKey);
  if (cached) return cached;
  const identity = resolveProjectIdentity(
    workspace.uri.fsPath,
    override,
  );
  PROJECT_IDENTITIES.set(cacheKey, identity);
  return identity;
}

function eventFor(
  workspace: vscode.WorkspaceFolder,
  deviceId: string,
  eventType: NormalizedEventV2["eventType"],
  title: string,
  attributes: NormalizedEventV2["attributes"],
  privacyRule: string,
): NormalizedEventV2Draft {
  const occurredAt = new Date().toISOString();
  const identity = projectIdentityFor(workspace);
  const event = {
    version: "2" as const,
    id: randomUUID(),
    deviceId,
    occurredAt,
    hlc: hybridLogicalClock(deviceId),
    source: "vscode" as const,
    eventType,
    ...(identity.projectId ? { projectId: identity.projectId } : {}),
    projectLocator: {
      localAlias: identity.localAlias,
      ...(identity.repositoryFingerprint
        ? { repositoryFingerprint: identity.repositoryFingerprint }
        : {}),
    },
    sessionId: SESSION_ID,
    title,
    attributes: { ...attributes, projectName: identity.normalizedName },
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
    `${event.source}\0${event.eventType}\0${identity.localAlias}\0${JSON.stringify(attributes)}\0${occurredAt.slice(0, 16)}`,
  );
  return event;
}

function privacyDropEvent(
  workspace: vscode.WorkspaceFolder,
  deviceId: string,
  rule: string,
): NormalizedEventV2Draft {
  const occurredAt = new Date().toISOString();
  const identity = projectIdentityFor(workspace);
  return {
    version: "2",
    id: randomUUID(),
    deviceId,
    occurredAt,
    hlc: hybridLogicalClock(deviceId),
    source: "vscode",
    eventType: "privacy.drop.aggregate",
    ...(identity.projectId ? { projectId: identity.projectId } : {}),
    projectLocator: {
      localAlias: identity.localAlias,
      ...(identity.repositoryFingerprint
        ? { repositoryFingerprint: identity.repositoryFingerprint }
        : {}),
    },
    sessionId: SESSION_ID,
    title: "Sensitive editor event dropped",
    attributes: { rule, count: 1, projectName: identity.normalizedName },
    privacy: {
      classification: "public",
      rules: ["aggregate-only", rule],
    },
    relevance: {
      decision: "keep",
      reason: "privacy-audit-counter",
    },
    confidence: 1,
    dedupeKey: hash(`vscode\0drop\0${identity.localAlias}\0${rule}\0${occurredAt}`),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const deviceId = resolveDeviceId();
  const queue = new DurableEventQueue(
    vscode.Uri.joinPath(context.globalStorageUri, "sanitized-events.json").fsPath,
  );
  const getEndpoint = (): string =>
    vscode.workspace
      .getConfiguration("continuum")
      .get<string>("endpoint", "http://127.0.0.1:43117");
  const getToken = async (): Promise<string | undefined> =>
    (await context.secrets.get(TOKEN_KEY)) || process.env.CONTINUUM_TOKEN;
  const policies = new PrivacyPolicyCache(
    vscode.Uri.joinPath(context.globalStorageUri, "privacy-policy-v1.json").fsPath,
    getEndpoint,
    getToken,
  );
  const transport = new EventTransport(
    queue,
    getEndpoint,
    getToken,
    policies,
  );

  const reportFailure = (error: unknown): void => {
    console.error("Continuum collector retained a sanitized event for retry:", error);
  };

  const submit = (event: NormalizedEventV2Draft): void => {
    void transport.submit(event).catch(reportFailure);
  };

  const collectWorkspaceFocus = (): void => {
    if (!captureEnabled() || !vscode.window.state.focused) return;
    const workspace = currentWorkspace();
    if (!workspace) return;
    const projectName = projectIdentityFor(workspace).normalizedName;
    submit(
      eventFor(
        workspace,
        deviceId,
        "workspace.focused",
        "Focused VS Code workspace",
        { workspace: projectName },
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
        submit(privacyDropEvent(workspace, deviceId, decision.reason));
      }
      return;
    }
    const relativePath = decision.relativePath;
    const languageId = sanitizeLabel(document.languageId, "unknown");
    submit(
      eventFor(
        workspace,
        deviceId,
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
