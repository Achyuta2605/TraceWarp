import type Anthropic from "@anthropic-ai/sdk";

/**
 * Rebuilds the final Message from a Messages API server-sent-event stream, so a streamed response can be
 * recorded the same way as a plain JSON one.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const chunk of text.replace(/\r\n/g, "\n").split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return events;
}

export class StreamError extends Error {}

type Block = Record<string, unknown> & { type: string };

/** Throws StreamError when the stream carried an `error` event or never started a message. */
export function messageFromSse(text: string): Anthropic.Message {
  let message: (Record<string, unknown> & { content: Block[]; usage: Record<string, unknown> }) | undefined;
  const partialJson = new Map<number, string>();
  for (const ev of parseSse(text)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const type = (data.type as string) ?? ev.event;
    if (type === "error") {
      const err = data.error as { type?: string; message?: string } | undefined;
      throw new StreamError(`stream error: ${err?.type ?? "unknown"}: ${err?.message ?? ""}`.trim());
    }
    if (type === "message_start") {
      const m = data.message as Record<string, unknown>;
      message = { ...m, content: [], usage: { ...(m.usage as Record<string, unknown>) } };
      continue;
    }
    if (!message) continue;
    const index = data.index as number;
    if (type === "content_block_start") {
      const block = { ...(data.content_block as Block) };
      message.content[index] = block;
      if (block.type === "tool_use" || block.type === "server_tool_use") partialJson.set(index, "");
    } else if (type === "content_block_delta") {
      const block = message.content[index];
      const delta = data.delta as Record<string, unknown>;
      if (!block) continue;
      switch (delta.type) {
        case "text_delta":
          block.text = `${(block.text as string) ?? ""}${delta.text as string}`;
          break;
        case "input_json_delta":
          partialJson.set(index, `${partialJson.get(index) ?? ""}${delta.partial_json as string}`);
          break;
        case "thinking_delta":
          block.thinking = `${(block.thinking as string) ?? ""}${delta.thinking as string}`;
          break;
        case "signature_delta":
          block.signature = delta.signature;
          break;
        case "citations_delta":
          block.citations = [...((block.citations as unknown[]) ?? []), delta.citation];
          break;
      }
    } else if (type === "content_block_stop") {
      const block = message.content[index];
      const json = partialJson.get(index);
      if (block && json !== undefined) {
        block.input = json.trim() ? JSON.parse(json) : {};
        partialJson.delete(index);
      }
    } else if (type === "message_delta") {
      const delta = data.delta as Record<string, unknown>;
      for (const [k, v] of Object.entries(delta)) message[k] = v;
      if (data.usage) Object.assign(message.usage, data.usage);
    }
  }
  if (!message) throw new StreamError("stream ended before a message started");
  message.content = message.content.filter(Boolean);
  return message as unknown as Anthropic.Message;
}
