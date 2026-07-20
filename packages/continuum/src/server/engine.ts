import type { RuntimeConfig } from "../runtime.js";
import { ContinuumDatabase } from "../db/database.js";
import { EmbeddingService } from "../retrieval/embeddings.js";
import { ContextService } from "../retrieval/context-service.js";
import { ProviderRegistry } from "../providers/registry.js";
import { EventPipeline } from "../pipeline/event-pipeline.js";
import { ChatProviderRegistry } from "../providers/chat.js";
import { SyncClient } from "../sync/client.js";

export interface Engine {
  config: RuntimeConfig;
  database: ContinuumDatabase;
  embeddings: EmbeddingService;
  contexts: ContextService;
  cloudContexts: ContextService;
  providers: ProviderRegistry;
  chatProviders: ChatProviderRegistry;
  pipeline: EventPipeline;
  sync: SyncClient;
  close(): void;
}

export async function createEngine(config: RuntimeConfig): Promise<Engine> {
  const database = new ContinuumDatabase(config.databasePath, { deviceIdentityPath: config.deviceIdentityPath });
  await database.initializeVector();
  const embeddings = new EmbeddingService();
  void embeddings.status();
  const providers = new ProviderRegistry(config);
  if (database.shouldAutoSelectProvider()) {
    const appleHealth = await providers.appleHealth();
    if (appleHealth.status === "available") {
      database.setModelSettings({ activeCheckpointProvider: "apple", activeChatProvider: "apple" }, { automatic: true });
    }
  }
  const chatProviders = new ChatProviderRegistry(config);
  const contexts = new ContextService(database, embeddings);
  const cloudContexts = new ContextService(database, embeddings, { cloudEligibleOnly: true });
  const pipeline = new EventPipeline(database, providers, embeddings);
  const sync = new SyncClient(database, config);
  sync.start();
  return {
    config,
    database,
    embeddings,
    contexts,
    cloudContexts,
    providers,
    chatProviders,
    pipeline,
    sync,
    close: () => {
      sync.close();
      pipeline.close();
      database.close();
    }
  };
}
