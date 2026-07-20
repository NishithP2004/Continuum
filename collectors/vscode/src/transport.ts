import type { EventBatchV2, NormalizedEventV2Draft } from "./types";
import { DurableEventQueue } from "./queue";
import { applyVscodePolicy, PrivacyPolicyCache } from "./policy";

export function validateLoopbackEndpoint(input: string): string {
  const url = new URL(input);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.port !== "43117" || url.username || url.password) {
    throw new Error("Continuum endpoint must be the fixed unauthenticated loopback origin on port 43117");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export class EventTransport {
  private flushPromise?: Promise<void>;

  constructor(
    private readonly queue: DurableEventQueue,
    private readonly getEndpoint: () => string,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly policies: PrivacyPolicyCache,
  ) {}

  async submit(event: NormalizedEventV2Draft): Promise<void> {
    const policy = await this.policies.current();
    const sanitized = applyVscodePolicy(event, policy);
    if (!sanitized) {
      await this.flush();
      return;
    }
    await this.queue.enqueue(sanitized, policy.retentionHours);
    await this.flush();
  }

  flush(): Promise<void> {
    if (!this.flushPromise) {
      this.flushPromise = this.flushInner().finally(() => {
        this.flushPromise = undefined;
      });
    }
    return this.flushPromise;
  }

  private async flushInner(): Promise<void> {
    const policy = await this.policies.current(true);
    const pending = (await this.queue.reconcile(
      (event) => applyVscodePolicy(event, policy),
      policy.retentionHours,
    )).slice(0, 100);
    if (pending.length === 0) return;
    const token = (await this.getToken())?.trim();
    if (!token) return;

    const endpoint = validateLoopbackEndpoint(this.getEndpoint());
    const body: EventBatchV2 = { events: pending };
    const response = await fetch(`${endpoint}/v1/events/batch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      throw new Error(`Continuum engine rejected events (${response.status})`);
    }
    await this.queue.remove(new Set(pending.map((event) => event.id)), policy.retentionHours);
  }
}
