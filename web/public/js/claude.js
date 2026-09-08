/**
 * Talks to the local backend, which relays to Claude. The API key lives
 * server-side; this module only ever sees text.
 */

/**
 * Streams one assistant turn. `messages` is the full conversation so far —
 * the backend is stateless, so the browser owns the history.
 *
 * @returns {Promise<string>} the complete reply text
 */
export async function streamReply(messages, { onDelta, abortSignal } = {}) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => body?.error)
      .catch(() => null);
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error("Streaming is not supported by this browser.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; anything after the last one
    // is a partial frame and stays in the buffer.
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!payload) continue;

      const event = JSON.parse(payload);
      if (event.type === "delta") {
        full += event.text;
        onDelta?.(event.text, full);
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
  }

  return full;
}
