type GenerationTask<T> = () => Promise<T>;

const schedulerTails = new Map<string, Promise<void>>();

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function observeAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Ollama serves one generation at a time for each configured endpoint/model.
 * The internal tail remains queued even when a caller stops waiting, so an
 * aborted queued request cannot let a later request overlap the active model.
 */
export function scheduleOllamaGeneration<T>(
  baseUrl: string,
  model: string,
  signal: AbortSignal | undefined,
  task: GenerationTask<T>
): Promise<T> {
  const key = `${baseUrl}\0${model}`;
  const prior = schedulerTails.get(key) ?? Promise.resolve();
  const operation = prior.then(async () => {
    signal?.throwIfAborted();
    return task();
  });
  const tail = operation.then(() => undefined, () => undefined);
  schedulerTails.set(key, tail);
  void tail.then(() => {
    if (schedulerTails.get(key) === tail) schedulerTails.delete(key);
  });
  return observeAbort(operation, signal);
}
