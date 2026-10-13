/** Reads a request body without buffering more than maxBytes. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBoundedBytes(request, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

export async function readBoundedBytes(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      cancelBody(request.body);
      return null;
    }
  }

  if (!request.body) return new Uint8Array(0);

  signal?.throwIfAborted();
  const reader = request.body.getReader();
  const abort = () => cancelBody(reader);
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        cancelBody(reader);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Best-effort body/reader cancel; must not delay a rejection response. */
export function cancelBody(body: { cancel(): Promise<void> } | null): void {
  try {
    void body?.cancel().catch(() => undefined);
  } catch {
    // Ignore cancel failures.
  }
}
