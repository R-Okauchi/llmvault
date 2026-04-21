/**
 * Converts a browser extension Port into an AsyncGenerator of StreamEvents.
 * Uses a queue pattern — the Port pushes messages, the generator pulls them.
 */

import type { ExtensionPort } from "./detect.js";
import type { StreamEvent, ChatStreamRequest } from "./types.js";

/**
 * Open a streaming chat session over a Port.
 * Yields StreamEvents until the extension sends "done" or "error", or the Port disconnects.
 */
export async function* portToStream(
  port: ExtensionPort,
  request: ChatStreamRequest,
): AsyncGenerator<StreamEvent> {
  const queue: Array<StreamEvent | null> = [];
  let waiting: (() => void) | null = null;

  function enqueue(item: StreamEvent | null): void {
    queue.push(item);
    if (waiting) {
      waiting();
      waiting = null;
    }
  }

  const onMessage = (msg: unknown): void => {
    const event = msg as StreamEvent;
    enqueue(event);
    if (event.type === "done" || event.type === "error") {
      enqueue(null); // Signal end of stream
    }
  };

  const onDisconnect = (): void => {
    enqueue(null);
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);

  // Send the chat request to start streaming
  port.postMessage(request);

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          waiting = r;
        });
      }

      const event = queue.shift()!;
      if (event === null) break;
      yield event;
    }
  } finally {
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    port.disconnect();
  }
}
