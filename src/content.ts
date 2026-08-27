import type { ConvertBatchRequest, ConvertItem, RuntimeMessage, StateChangedMessage } from "./types";

let isFuriganaActive = false;
let isProcessing = false;
const processedElements = new WeakSet<Element>();
const pendingMutationNodes = new Set<Node>();
let mutationTimer: number | null = null;
let mutationObserver: MutationObserver | null = null;

const BATCH_SIZE = 50;
const KANJI_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF]/;
// Japanese Kana (Hiragana & Katakana) required to distinguish Japanese from Chinese Hanzi
const KANA_REGEX = /[\u3040-\u309F\u30A0-\u30FF]/;
const KANA_PREFIX_REGEX = /^[\u3040-\u309F]/;

const BLOCK_TAGS_REGEX = /^(H[1-6]|P|DIV|SECTION|ARTICLE|LI|TR|TD|TH|TABLE|BODY|MAIN|HEADER|FOOTER|NAV|ASIDE)$/i;

const IGNORED_TAGS = new Set<string>([
  // Ruby elements (prevent recursive annotation)
  "RUBY", "RT", "RP", "RTC",

  // Document metadata, styles, scripts, and inert templates
  "HEAD", "TITLE", "META", "LINK", "STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE",

  // Form controls & plaintext-only inputs
  "INPUT", "TEXTAREA", "SELECT", "OPTION", "OPTGROUP", "DATALIST",

  // Code, monospace, and terminal formatting
  "CODE", "PRE", "KBD", "SAMP", "VAR",

  // Embedded, graphics, and media
  "SVG", "CANVAS", "MATH", "IFRAME", "EMBED", "OBJECT", "AUDIO", "VIDEO"
]);

function notifyState(active: boolean): void {
  try {
    const message: StateChangedMessage = { type: "state_changed", active };
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Context may be invalidated if extension reloaded
  }
}

async function convertBatch(items: Array<string | ConvertItem>): Promise<string[]> {
  if (!items.length) {
    return [];
  }

  return new Promise((resolve, reject) => {
    const payload: ConvertBatchRequest = { type: "convert_batch", contents: items };
    chrome.runtime.sendMessage(payload, (response: { ok: boolean; result?: string[]; error?: string }) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (response && response.ok && Array.isArray(response.result)) {
        resolve(response.result);
      } else {
        reject(new Error((response && response.error) || "Batch conversion failed"));
      }
    });
  });
}

function getNextSiblingText(node: Node): string {
  let curr: Node | null = node;
  while (curr) {
    if (curr.nextSibling) {
      let next: Node | null = curr.nextSibling;
      while (next) {
        if (next.nodeType === Node.TEXT_NODE) {
          const val = (next.nodeValue || "").trim();
          if (val) {
            return val;
          }
        } else if (next.nodeType === Node.ELEMENT_NODE) {
          const el = next as Element;
          if (IGNORED_TAGS.has(el.nodeName) || BLOCK_TAGS_REGEX.test(el.nodeName)) {
            break;
          }
          if (next.firstChild) {
            next = next.firstChild;
            continue;
          }
        }
        next = next.nextSibling;
      }
    }
    curr = curr.parentElement;
    if (!curr || BLOCK_TAGS_REGEX.test(curr.nodeName)) {
      break;
    }
  }
  return "";
}

function isNodeEligible(node: Node | null): node is Text {
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    return false;
  }
  const text = node.nodeValue;
  if (!text || !text.trim() || !KANJI_REGEX.test(text)) {
    return false;
  }

  let parent = node.parentElement;
  while (parent) {
    // 1. Blacklisted element tags
    if (IGNORED_TAGS.has(parent.nodeName)) {
      return false;
    }

    // 2. Rich-text and editable contexts
    if (parent.isContentEditable) {
      return false;
    }

    // 3. W3C translation opt-out directives and icon font classes
    if (
      parent.getAttribute("translate") === "no" ||
      parent.classList?.contains("notranslate") ||
      parent.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }

    // 4. Previously processed nodes
    if (processedElements.has(parent)) {
      return false;
    }

    parent = parent.parentElement;
  }
  return true;
}

function collectTextNodes(root: Node): Text[] {
  const textNodes: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) {
    if (isNodeEligible(root)) {
      textNodes.push(root);
    }
    return textNodes;
  }

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node) {
        return isNodeEligible(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    }
  );

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }
  return textNodes;
}

async function processNodes(nodes: Text[]): Promise<void> {
  const eligibleNodes = nodes.filter((node) => isNodeEligible(node) && node.parentNode);
  if (!eligibleNodes.length) {
    return;
  }

  for (let i = 0; i < eligibleNodes.length; i += BATCH_SIZE) {
    const chunk = eligibleNodes.slice(i, i + BATCH_SIZE);
    const validChunk = chunk.filter((node) => node.parentNode);
    if (!validChunk.length) {
      continue;
    }

    const items: ConvertItem[] = validChunk.map((node) => {
      const text = node.nodeValue || "";
      // If text ends with a Kanji, check if the adjacent inline sibling has okurigana
      if (KANJI_REGEX.test(text.slice(-1))) {
        const nextText = getNextSiblingText(node);
        if (nextText && KANA_PREFIX_REGEX.test(nextText)) {
          return { text, nextContext: nextText.slice(0, 8) };
        }
      }
      return { text };
    });

    try {
      const htmlResults = await convertBatch(items);

      validChunk.forEach((node, index) => {
        const html = htmlResults[index];
        if (!html || html === node.nodeValue || !node.parentNode) {
          return;
        }

        const fragment = document.createRange().createContextualFragment(html);
        for (let j = 0; j < fragment.childNodes.length; j++) {
          const child = fragment.childNodes[j];
          if (child instanceof HTMLElement) {
            processedElements.add(child);
          }
        }
        node.parentNode.replaceChild(fragment, node);
      });
    } catch (error) {
      console.debug("[Fast Furigana] Error converting batch:", error);
    }
  }
}

async function processSubtree(root: Node): Promise<void> {
  const nodes = collectTextNodes(root);
  await processNodes(nodes);
}

function flushPendingMutations(): void {
  if (!pendingMutationNodes.size) {
    return;
  }

  const roots = Array.from(pendingMutationNodes);
  pendingMutationNodes.clear();

  const allTextNodes: Text[] = [];
  for (const root of roots) {
    if (root.isConnected) {
      allTextNodes.push(...collectTextNodes(root));
    }
  }

  if (allTextNodes.length) {
    processNodes(allTextNodes);
  }
}

function scheduleMutationFlush(): void {
  if (mutationTimer !== null) {
    return;
  }

  const scheduleFn = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback ||
    ((cb: () => void) => setTimeout(cb, 40) as unknown as number);

  mutationTimer = scheduleFn(() => {
    mutationTimer = null;
    flushPendingMutations();
  });
}

function observeMutations(): void {
  if (mutationObserver) {
    return;
  }

  mutationObserver = new MutationObserver((mutations: MutationRecord[]) => {
    if (!isFuriganaActive) {
      return;
    }

    let hasNewNodes = false;
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (let i = 0; i < mutation.addedNodes.length; i++) {
          const addedNode = mutation.addedNodes[i];
          if (addedNode.nodeType === Node.TEXT_NODE) {
            pendingMutationNodes.add(addedNode);
            hasNewNodes = true;
          } else if (addedNode.nodeType === Node.ELEMENT_NODE) {
            const el = addedNode as Element;
            if (!IGNORED_TAGS.has(el.nodeName) && !processedElements.has(el)) {
              pendingMutationNodes.add(el);
              hasNewNodes = true;
            }
          }
        }
      }
    }

    if (hasNewNodes) {
      scheduleMutationFlush();
    }
  });

  mutationObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });
}

export async function applyFurigana(): Promise<void> {
  if (isFuriganaActive || isProcessing) {
    return;
  }
  isProcessing = true;

  try {
    if (document.body) {
      await processSubtree(document.body);
      isFuriganaActive = true;
      observeMutations();
      notifyState(true);
    }
  } finally {
    isProcessing = false;
  }
}

export function removeFurigana(): void {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }

  if (mutationTimer !== null) {
    if (typeof (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback === "function") {
      (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(mutationTimer);
    } else {
      clearTimeout(mutationTimer);
    }
    mutationTimer = null;
  }
  pendingMutationNodes.clear();

  const rubyElements = document.querySelectorAll("ruby");
  for (let i = 0; i < rubyElements.length; i++) {
    const ruby = rubyElements[i];
    const baseTexts: string[] = [];
    for (let j = 0; j < ruby.childNodes.length; j++) {
      const child = ruby.childNodes[j];
      if (child.nodeName !== "RT" && child.nodeName !== "RP" && child.nodeName !== "RTC") {
        baseTexts.push(child.textContent || "");
      }
    }
    const originalText = baseTexts.join("");
    const textNode = document.createTextNode(originalText);
    ruby.parentNode?.replaceChild(textNode, ruby);
  }

  isFuriganaActive = false;
  notifyState(false);
}

export function toggleFurigana(): void {
  if (isFuriganaActive) {
    removeFurigana();
  } else {
    applyFurigana();
  }
}

function isJapanesePage(): boolean {
  const htmlLang = (document.documentElement.lang || "").toLowerCase();

  // 1. Explicitly exclude Chinese & Korean pages
  if (htmlLang.startsWith("zh") || htmlLang.startsWith("ko")) {
    return false;
  }

  // 2. Explicit Japanese declaration
  if (htmlLang.startsWith("ja")) {
    return true;
  }

  // 3. Fallback: Require Japanese Kana (Hiragana or Katakana)
  // Pure Chinese sites contain zero Kana; Japanese pages always contain Kana particles & endings
  const sample = (document.title + " " + (document.body ? document.body.innerText.slice(0, 1500) : "")).trim();
  return KANA_REGEX.test(sample);
}

function autoInit(): void {
  if (isJapanesePage()) {
    applyFurigana();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", autoInit);
} else {
  autoInit();
}

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: { active?: boolean }) => void
  ) => {
    if (message.type === "toggle") {
      toggleFurigana();
      sendResponse({ active: isFuriganaActive });
    } else if (message.type === "init") {
      applyFurigana();
      sendResponse({ active: isFuriganaActive });
    } else if (message.type === "get_state") {
      sendResponse({ active: isFuriganaActive });
    }
  }
);
