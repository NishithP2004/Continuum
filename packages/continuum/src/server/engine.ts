import type { RuntimeConfig } from "../runtime.js";
import { ContinuumDatabase } from "../db/database.js";
import { EmbeddingService } from "../retrieval/embeddings.js";
import { ContextService } from "../retrieval/context-service.js";
import { ProviderRegistry } from "../providers/registry.js";
import { EventPipeline } from "../pipeline/event-pipeline.js";

export interface Engine {
  config: RuntimeConfig;
  database: ContinuumDatabase;
  embeddings: EmbeddingService;
  contexts: ContextService;
  providers: ProviderRegistry;
  pipeline: EventPipeline;
  close(): void;
}

export async function createEngine(config: RuntimeConfig): Promise<Engine> {
  const database = new ContinuumDatabase(config.databasePath);
  await database.initializeVector();
  const embeddings = new EmbeddingService();
  const providers = new ProviderRegistry(config);
  const contexts = new ContextService(database, embeddings);
  const pipeline = new EventPipeline(database, providers, embeddings);
  return {
    config,
    database,
    embeddings,
    contexts,
    providers,
    pipeline,
    close: () => {
      pipeline.close();
      database.close();
    }
  };
}
