import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  stripCommandAddressingMentions,
  stripMentions,
  stripStructuralPrefixes,
} from "./mentions.js";

vi.mock("../../channels/plugins/registry-loaded.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/registry-loaded.js")>()),
  getLoadedChannelPluginById: (id: string) =>
    id === "discord"
      ? {
          mentions: {
            stripPatterns: () => ["@12345"],
            stripMentions: ({ text }: { text: string }) =>
              text
                .replace(/<@bot>/gu, "")
                .replace(/<\s*>/gu, "")
                .replace("[Bot Name]", "")
                .replaceAll("[A A]", "")
                .replace("@Norma", ""),
          },
        }
      : undefined,
}));

function mention(name: string, emoji?: string) {
  const cfg: OpenClawConfig = {
    agents: { entries: { agent: { identity: { name, emoji } } } },
  };
  const regexes = buildMentionRegexes(cfg, "agent");
  return {
    regexes,
    matches: (text: string) => matchesMentionPatterns(text, regexes),
    strip: (text: string) => stripMentions(text, {}, cfg, "agent"),
  };
}

describe("stripStructuralPrefixes", () => {
  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips slash-like display labels only after an envelope", () => {
    expect(stripStructuralPrefixes("[Telegram /reset id:123] /reset: hello")).toBe("hello");
  });

  it("does not treat a payload marker literal as structure", () => {
    const body = "please explain [Current message - respond to this] /status";
    expect(stripStructuralPrefixes(body)).toBe(body);
  });

  it("does not mine commands from ambiguous flat history", () => {
    const marker = "[Recent chat messages - for context]";
    const body = `${marker}\nOther: quoted [Current message - respond to this] /reset\n\n[Current message - respond to this]\nOwner: /status`;
    expect(stripStructuralPrefixes(body)).toBe(body);
  });

  it("preserves real line breaks in slash commands for downstream command parsing", () => {
    expect(stripStructuralPrefixes("/reset soft\nre-read persona files")).toBe(
      "/reset soft\nre-read persona files",
    );
    expect(stripStructuralPrefixes("/reset \\nsoft")).toBe("/reset soft");
  });
});

describe("derived mention matching and stripping", () => {
  it("matches single-character Han names without matching Unicode substrings", () => {
    const bot = mention("包");
    expect(bot.matches("@包 你好")).toBe(true);
    expect(bot.matches("包 你好")).toBe(true);
    expect(bot.matches("前包後")).toBe(false);
    expect(bot.matches("包みを開ける")).toBe(false);
    expect(bot.matches("包\u0301")).toBe(false);
    expect(bot.strip("@包 你好")).toBe("你好");
    expect(bot.strip("包みを開ける")).toBe("包みを開ける");
  });

  it("keeps explicit configured patterns on their existing regex flags", () => {
    const regexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: [String.raw`\bopenclaw\b`] } },
    });
    expect(regexes[0]?.flags).toBe("i");
  });

  it("accepts interior decoration once, as whitespace, or omitted", () => {
    const bot = mention("Papillon🦋Bot");
    expect(bot.matches("Papillon🦋Bot help")).toBe(true);
    expect(bot.matches("papillon bot help")).toBe(true);
    expect(bot.matches("PapillonBot help")).toBe(true);
    expect(bot.matches("Papillon🦋🦋Bot /status")).toBe(false);
    expect(bot.strip("Papillon🦋🦋Bot /status")).toBe("Papillon🦋🦋Bot /status");
    expect(bot.strip("Papillon🦋Bot /status")).toBe("/status");
    expect(bot.matches("papillon...bot help")).toBe(false);
  });

  it("keeps punctuation required when it shares a gap with decoration", () => {
    const bot = mention("Clawd ・🦋 Bot");
    expect(bot.matches("clawd ・🦋 bot status")).toBe(true);
    expect(bot.matches("clawd bot status")).toBe(false);
    expect(bot.matches("clawd🦋bot status")).toBe(false);
  });

  it("strips a spaced gap whose raw spelling also carries a joiner", () => {
    const bot = mention("क‍ ख");
    expect(bot.matches("क ख नमस्ते")).toBe(true);
    expect(bot.matches("कख नमस्ते")).toBe(false);
    expect(bot.strip("क‍ ख /status")).toBe("/status");
  });

  it("matches a configured identity emoji that carries a joiner", () => {
    const bot = mention("Clawd", "👩‍👧");
    expect(bot.matches("👩‍👧 status")).toBe(true);
    expect(bot.matches("clawd status")).toBe(true);
  });

  it("accepts the identity's numeric keycap without accepting bare or foreign digits", () => {
    const bot = mention("Bot1️⃣");
    expect(bot.matches("bot 早安")).toBe(true);
    expect(bot.matches("bot1️⃣ 早安")).toBe(true);
    expect(bot.matches("bot1 早安")).toBe(false);
    expect(bot.matches("botx 早安")).toBe(false);
    expect(bot.matches("bot3️⃣ 早安")).toBe(false);
    expect(bot.strip("bot /status")).toBe("/status");
    expect(bot.strip("bot1️⃣ /status")).toBe("/status");
    expect(bot.strip("bot1 /status")).toBe("bot1 /status");
    expect(bot.strip("bot3️⃣ /status")).toBe("bot3️⃣ /status");
  });

  it("reads spaced interior decoration once while keeping a separator floor", () => {
    const bot = mention("Clawd 🦋 ★ Bot");
    expect(bot.matches("clawd 🦋 ★ bot status")).toBe(true);
    expect(bot.matches("clawd🦋★bot status")).toBe(true);
    expect(bot.matches("clawd bot status")).toBe(true);
    expect(bot.matches("clawd 🦋 🦋 ★ bot status")).toBe(false);
    expect(bot.matches("clawdbot status")).toBe(false);
    expect(bot.matches("@clawdbot status")).toBe(false);
  });

  it("derives no pattern from an identity that normalization empties", () => {
    const bot = mention("\u200D");
    expect(bot.regexes).toHaveLength(0);
    expect(bot.matches("hello!")).toBe(false);
  });

  it("strips markless edge joiners without stripping part of a joined word", () => {
    const trailing = mention("क‍");
    const leading = mention("‍क");
    expect(trailing.matches("क नमस्ते")).toBe(true);
    expect(leading.matches("क नमस्ते")).toBe(true);
    expect(trailing.strip("क‍ /status")).toBe("/status");
    expect(leading.strip("‍क /status")).toBe("/status");
    expect(trailing.strip("क /status")).toBe("/status");
    expect(trailing.matches("कख नमस्ते")).toBe(false);
    expect(trailing.strip("क‍ख नमस्ते")).toBe("क‍ख नमस्ते");
  });

  it("rejects a long joined suffix without quadratic stripping", () => {
    const bot = mention("Bot🦋");
    const message = `Bot${"\u200D".repeat(32_768)}X /status`;
    const startedAt = performance.now();
    expect(bot.strip(message)).toBe(message);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("command mention stripping", () => {
  const cfg: OpenClawConfig = {
    messages: { groupChat: { mentionPatterns: ["@Norma", "Norma"] } },
  };

  it("removes leading and command-suffix mentions", () => {
    expect(stripCommandAddressingMentions("@Norma /status", {}, cfg)).toBe("/status");
    expect(stripCommandAddressingMentions("/status@Norma", {}, cfg)).toBe("/status");
    expect(stripCommandAddressingMentions("/status@NormaEvil", {}, cfg)).toBe("/status@NormaEvil");
    expect(stripCommandAddressingMentions("/status@Norma.extra", {}, cfg)).toBe(
      "/status@Norma.extra",
    );
    const splitSuffixCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: ["@Norma", "Evil"] } },
    };
    expect(stripCommandAddressingMentions("/status@NormaEvil", {}, splitSuffixCfg)).toBe(
      "/status@NormaEvil",
    );
    expect(stripCommandAddressingMentions("/status@NormaEvil", { Provider: "discord" }, {})).toBe(
      "/status@NormaEvil",
    );
  });

  it("preserves matching text in command arguments", () => {
    const command = "/acp spawn codex --cwd /Users/me/norma/projects/linkauto-app";
    expect(stripCommandAddressingMentions(command, {}, cfg)).toBe(command);
    expect(stripCommandAddressingMentions("/steer:Norma continue", {}, cfg)).toBe(
      "/steer:Norma continue",
    );
  });

  it("continues removing standalone addressing mentions after commands", () => {
    expect(stripCommandAddressingMentions("/steer Norma", {}, cfg)).toBe("/steer");
    expect(stripCommandAddressingMentions("/status @Norma", {}, cfg)).toBe("/status");
    expect(stripCommandAddressingMentions("/steer @Norma continue", {}, cfg)).toBe(
      "/steer continue",
    );
    expect(
      stripCommandAddressingMentions("/steer @Norma preserve  two spaces\nand a newline", {}, cfg),
    ).toBe("/steer preserve  two spaces\nand a newline");
  });

  it("strips configured mentions whose pattern consumes its whitespace boundary", () => {
    const boundaryCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: [String.raw`(?:^|\s)@Norma(?=$|\s)`] } },
    };
    expect(stripCommandAddressingMentions("/status @Norma", {}, boundaryCfg)).toBe("/status");
    const suffixBoundaryCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: [String.raw`@Norma(?:$|\s)`] } },
    };
    expect(stripCommandAddressingMentions("/status@Norma continue", {}, suffixBoundaryCfg)).toBe(
      "/status continue",
    );
  });

  it("does not strip a configured pattern from the command name", () => {
    const commandCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: ["acp"] } },
    };
    expect(stripCommandAddressingMentions("/acp spawn codex", {}, commandCfg)).toBe(
      "/acp spawn codex",
    );
  });

  it("evaluates configured patterns against the complete command text", () => {
    const anchoredCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: ["acp$"] } },
    };
    const command = "/acp spawn codex --cwd /tmp/app";

    expect(stripCommandAddressingMentions(command, {}, anchoredCfg)).toBe(command);
  });

  it("ignores zero-width mention matches in command arguments", () => {
    const zeroWidthCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: ["$"] } },
    };
    const command = "/steer preserve  two spaces\nand a newline";

    expect(stripCommandAddressingMentions(command, {}, zeroWidthCfg)).toBe(command);
  });

  it("strips standalone provider mentions without changing embedded argument text", () => {
    const ctx = { Provider: "discord" };
    expect(stripCommandAddressingMentions("/status <@bot>", ctx, {})).toBe("/status");
    expect(stripCommandAddressingMentions("/status [Bot Name]", ctx, {})).toBe("/status");
    expect(stripCommandAddressingMentions("/status [A A] A", ctx, {})).toBe("/status A");
    expect(stripCommandAddressingMentions("/status [A A] A [A A] tail", ctx, {})).toBe(
      "/status A tail",
    );
    expect(stripCommandAddressingMentions("/steer A AA", ctx, {})).toBe("/steer A AA");
    expect(stripCommandAddressingMentions("/steer /path/<@bot>/file", ctx, {})).toBe(
      "/steer /path/<@bot>/file",
    );
    expect(stripCommandAddressingMentions("/steer <@bot>/file", ctx, {})).toBe(
      "/steer <@bot>/file",
    );
    expect(stripCommandAddressingMentions("/steer /path/[Bot Name]/file", ctx, {})).toBe(
      "/steer /path/[Bot Name]/file",
    );
    expect(stripCommandAddressingMentions("/steer [Bot Name]/file", ctx, {})).toBe(
      "/steer [Bot Name]/file",
    );
  });

  it("handles unmatched provider delimiters without quadratic scanning", () => {
    const command = `/steer ${"[ ".repeat(16_384)}`;
    const startedAt = performance.now();
    expect(stripCommandAddressingMentions(command, { Provider: "discord" }, {})).toBe(command);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("keeps full mention stripping for non-command text", () => {
    expect(stripCommandAddressingMentions("hello Norma", {}, cfg)).toBe("hello");
    expect(stripMentions("hello <@12345>", { Provider: "discord" }, {})).toBe("hello");
  });
});
