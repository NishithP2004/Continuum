export interface EmbeddingStatus {
  available: boolean;
  model: string;
  detail?: string;
}

type FeatureExtractor = (text: string, options: { pooling: "mean"; normalize: true }) => Promise<{ data: Float32Array | number[] }>;

export class EmbeddingService {
  readonly model = process.env.CONTINUUM_EMBEDDING_MODEL ?? "onnx-community/all-MiniLM-L6-v2-ONNX";
  private extractor?: FeatureExtractor;
  private failed?: string;
  private loading?: Promise<void>;

  peekStatus(): EmbeddingStatus {
    if (this.extractor) return { available: true, model: this.model };
    return {
      available: false,
      model: this.model,
      detail: this.failed ?? (this.loading ? "embedding model is initializing" : "embedding model has not been initialized")
    };
  }

  async status(): Promise<EmbeddingStatus> {
    await this.ensureLoaded();
    return this.peekStatus();
  }

  async embed(text: string): Promise<number[] | undefined> {
    await this.ensureLoaded();
    if (!this.extractor) return undefined;
    try {
      const output = await this.extractor(text.slice(0, 12_000), { pooling: "mean", normalize: true });
      const values = Array.from(output.data);
      return values.length === 384 ? values : undefined;
    } catch (error) {
      this.failed = error instanceof Error ? error.message : String(error);
      this.extractor = undefined;
      return undefined;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.extractor || this.failed) return;
    if (this.loading) return this.loading;
    if (process.env.CONTINUUM_DISABLE_EMBEDDINGS === "1") {
      this.failed = "disabled by CONTINUUM_DISABLE_EMBEDDINGS";
      return;
    }

    this.loading = (async () => {
      try {
        const transformers = await import("@huggingface/transformers");
        const extractor = await transformers.pipeline("feature-extraction", this.model, { dtype: "q4" });
        this.extractor = extractor as unknown as FeatureExtractor;
      } catch (error) {
        this.failed = error instanceof Error ? error.message : String(error);
      }
    })();

    await this.loading;
    this.loading = undefined;
  }
}
