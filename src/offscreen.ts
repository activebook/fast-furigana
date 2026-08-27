import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";
import type { ConvertItem, OffscreenRequest, OffscreenResponse } from "./types";

let kuroshiro: Kuroshiro | null = null;
let initPromise: Promise<void> | null = null;

const MAX_CACHE_SIZE = 5000;
const conversionCache = new Map<string, string>();
const KANA_PREFIX_REGEX = /^[\u3040-\u309F]/;

async function ensureInit(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    kuroshiro = new Kuroshiro();
    const dictPath = chrome.runtime.getURL("dict/");
    await kuroshiro.init(new KuromojiAnalyzer({ dictPath }));
  })();

  return initPromise;
}

// Eagerly initiate dictionary loading when the offscreen document is spawned
ensureInit().catch((err: unknown) => {
  console.error("Failed to initialize Kuroshiro in offscreen:", err);
});

function sliceRubyText(html: string, targetLength: number): string {
  const tokenRegex = /<ruby>(?:(?!<\/ruby>).)*<\/ruby>|[^<]/g;
  let accumulatedLength = 0;
  let result = "";

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(html)) !== null) {
    const token = match[0];
    if (token.startsWith("<ruby>")) {
      const baseMatch = token.match(/<ruby>(.*?)(?:<rp|<rt)/);
      const baseText = baseMatch ? baseMatch[1] : "";
      accumulatedLength += baseText.length;
      result += token;
    } else {
      accumulatedLength += token.length;
      result += token;
    }

    if (accumulatedLength >= targetLength) {
      break;
    }
  }
  return result || html;
}

async function getOrConvert(item: string | ConvertItem): Promise<string> {
  const text = typeof item === "string" ? item : item?.text;
  if (!text) {
    return "";
  }
  const nextContext = typeof item === "object" && item.nextContext ? item.nextContext : undefined;
  const cacheKey = `${text}::${nextContext || ""}`;

  const cached = conversionCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  if (!kuroshiro) {
    await ensureInit();
  }

  let result = "";
  if (nextContext && KANA_PREFIX_REGEX.test(nextContext)) {
    const combined = text + nextContext.slice(0, 8);
    const converted = await kuroshiro!.convert(combined, {
      mode: "furigana",
      to: "hiragana"
    });
    result = sliceRubyText(converted, text.length);
  } else {
    result = await kuroshiro!.convert(text, {
      mode: "furigana",
      to: "hiragana"
    });
  }

  if (conversionCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = conversionCache.keys().next().value;
    if (oldestKey !== undefined) {
      conversionCache.delete(oldestKey);
    }
  }
  conversionCache.set(cacheKey, result);

  return result;
}

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== "furigana-offscreen") {
    return;
  }

  port.onMessage.addListener(async (message: OffscreenRequest) => {
    const messageId = message?.id;
    try {
      await ensureInit();

      if (message.type === "convert_batch" && Array.isArray(message.contents)) {
        const results = await Promise.all(message.contents.map((item) => getOrConvert(item)));
        const response: OffscreenResponse = { id: messageId, ok: true, results };
        port.postMessage(response);
      } else if (message.type === "convert") {
        const result = await getOrConvert(message.content);
        const response: OffscreenResponse = { id: messageId, ok: true, result };
        port.postMessage(response);
      } else if (message.type === "ping") {
        const response: OffscreenResponse = { id: messageId, ok: true, result: "pong" };
        port.postMessage(response);
      } else {
        const response: OffscreenResponse = {
          id: messageId,
          ok: false,
          error: `Unknown message type: ${(message as { type?: string }).type}`
        };
        port.postMessage(response);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const response: OffscreenResponse = { id: messageId, ok: false, error: errorMsg };
      port.postMessage(response);
    }
  });
});
