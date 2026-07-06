// Tests reply history loading, trimming, and rendering for prompt context.
import { describe, expect, it } from "vitest";
import {
  appendRecentHistoryImageContext,
  resolveRecentInboundHistoryImages,
} from "./history-media.js";
import { normalizeHistoryMediaEntries, recordPendingHistoryEntryWithMedia } from "./history.js";
import type { HistoryEntry } from "./history.types.js";

describe("history media recording", () => {
  it("keeps only bounded local image media", () => {
    expect(
      normalizeHistoryMediaEntries({
        limit: 2,
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png" },
          { path: "https://example.com/b.png", contentType: "image/png" },
          { path: "/tmp/c.pdf", contentType: "application/pdf", kind: "document" },
          { path: "C:\\tmp\\d.jpg", kind: "image" },
          { path: "/tmp/e.jpg", kind: "image" },
        ],
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
      { path: "C:\\tmp\\d.jpg", kind: "image", messageId: "msg-1" },
    ]);
  });

  it("records text history unchanged when media resolver has no usable media", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();

    await recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "channel-1",
      limit: 5,
      entry: { sender: "Alice", body: "hello", messageId: "msg-1" },
      media: async () => [{ path: "https://example.com/a.png", contentType: "image/png" }],
    });

    expect(historyMap.get("channel-1")).toEqual([
      { sender: "Alice", body: "hello", messageId: "msg-1" },
    ]);
  });

  it("records text history before async media resolution finishes", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    let resolveMedia!: (media: HistoryEntry["media"]) => void;
    const mediaPromise = new Promise<HistoryEntry["media"]>((resolve) => {
      resolveMedia = resolve;
    });

    const pending = recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "channel-1",
      limit: 5,
      entry: { sender: "Alice", body: "<media:image>", messageId: "msg-1" },
      media: async () => await mediaPromise,
    });

    expect(historyMap.get("channel-1")).toEqual([
      { sender: "Alice", body: "<media:image>", messageId: "msg-1" },
    ]);

    resolveMedia([{ path: "/tmp/a.png", contentType: "image/png" }]);
    await pending;

    expect(historyMap.get("channel-1")).toEqual([
      {
        sender: "Alice",
        body: "<media:image>",
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
        ],
      },
    ]);
  });
});

describe("recent history image context", () => {
  it("carries timestamp and thread position metadata without exposing paths", () => {
    const now = 1_700_000_000_000;
    const images = resolveRecentInboundHistoryImages({
      ctx: {
        Body: "what changed?",
        Timestamp: now,
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:image>",
            timestamp: now - 2_000,
            messageId: "msg-1",
            media: [
              { path: "history-images/secret-1.png", contentType: "image/png", kind: "image" },
            ],
          },
          {
            sender: "@bob",
            body: "<media:image>",
            timestamp: now - 1_000,
            messageId: "msg-2",
            media: [
              { path: "history-images/secret-2.png", contentType: "image/png", kind: "image" },
            ],
          },
        ],
      },
    });

    expect(images).toEqual([
      {
        path: "history-images/secret-1.png",
        contentType: "image/png",
        sender: "@alice",
        messageId: "msg-1",
        timestampMs: now - 2_000,
        historyPosition: 1,
        historyTotal: 2,
      },
      {
        path: "history-images/secret-2.png",
        contentType: "image/png",
        sender: "@bob",
        messageId: "msg-2",
        timestampMs: now - 1_000,
        historyPosition: 2,
        historyTotal: 2,
      },
    ]);

    const prompt = appendRecentHistoryImageContext({
      promptText: "what changed?",
      images,
    });

    expect(prompt).toContain(
      "[Recent image 1 from @alice, message msg-1, sent 2023-11-14T22:13:18.000Z, message 1 of 2 in thread, attached as media.]",
    );
    expect(prompt).toContain(
      "[Recent image 2 from @bob, message msg-2, sent 2023-11-14T22:13:19.000Z, message 2 of 2 in thread, attached as media.]",
    );
    expect(prompt).not.toContain("history-images/secret");
  });

  it("omits invalid recent history image timestamp and position metadata", () => {
    const prompt = appendRecentHistoryImageContext({
      promptText: "what is this?",
      images: [
        {
          path: "history-images/secret.png",
          contentType: "image/png",
          sender: "@alice",
          timestampMs: Number.MAX_VALUE,
          historyPosition: 3,
          historyTotal: 2,
        },
      ],
    });

    expect(prompt).toContain("[Recent image 1 from @alice, attached as media.]");
    expect(prompt).not.toContain("sent");
    expect(prompt).not.toContain("in thread");
    expect(prompt).not.toContain("history-images/secret.png");
  });
});
