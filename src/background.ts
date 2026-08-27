import type { OffscreenRequest, OffscreenResponse, RuntimeMessage, ToggleMessage } from "./types";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreen: Promise<void> | null = null;
let offscreenPort: chrome.runtime.Port | null = null;
let requestIdCounter = 0;

interface PendingRequest {
  resolve: (value: string | string[] | undefined) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<number, PendingRequest>();

async function hasOffscreenDocument(): Promise<boolean> {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    });
    return contexts.length > 0;
  }
  return false;
}

async function setupOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Host Kuroshiro analyzer for Japanese furigana conversion."
  });

  await creatingOffscreen;
  creatingOffscreen = null;
}

async function getOrConnectPort(): Promise<chrome.runtime.Port> {
  await setupOffscreenDocument();

  if (offscreenPort) {
    return offscreenPort;
  }

  offscreenPort = chrome.runtime.connect({ name: "furigana-offscreen" });

  offscreenPort.onMessage.addListener((response: OffscreenResponse) => {
    const messageId = response?.id;
    if (messageId !== undefined && pendingRequests.has(messageId)) {
      const { resolve, reject, timeout } = pendingRequests.get(messageId)!;
      clearTimeout(timeout);
      pendingRequests.delete(messageId);

      if (response.ok) {
        resolve(response.results !== undefined ? response.results : response.result);
      } else {
        reject(new Error(response.error || "Offscreen conversion failed"));
      }
    }
  });

  offscreenPort.onDisconnect.addListener(() => {
    const errorMsg = chrome.runtime.lastError?.message || "Offscreen port disconnected";
    for (const [, req] of pendingRequests.entries()) {
      clearTimeout(req.timeout);
      req.reject(new Error(errorMsg));
    }
    pendingRequests.clear();
    offscreenPort = null;
  });

  return offscreenPort;
}

async function sendToOffscreen(message: OffscreenRequest): Promise<string | string[] | undefined> {
  const port = await getOrConnectPort();
  const id = ++requestIdCounter;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Offscreen document timed out."));
    }, 30000);

    pendingRequests.set(id, { resolve, reject, timeout });
    port.postMessage({ ...message, id });
  });
}

function updateBadgeState(tabId: number, active: boolean): void {
  if (active) {
    chrome.action.setBadgeText({ tabId, text: "ON" });
    chrome.action.setBadgeTextColor?.({ tabId, color: "#FFFFFF" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#4F46E5" });
  } else {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
}

async function toggleActiveTab(tabId?: number): Promise<void> {
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }

  if (tabId) {
    const message: ToggleMessage = { type: "toggle" };
    chrome.tabs.sendMessage(tabId, message).then((response: { active?: boolean } | undefined) => {
      if (response && typeof response.active === "boolean" && tabId) {
        updateBadgeState(tabId, response.active);
      }
    }).catch(() => {});
  }
}

chrome.runtime.onStartup.addListener(() => {
  setupOffscreenDocument().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  setupOffscreenDocument().catch(() => {});
  chrome.contextMenus.create({
    id: "fast-furigana",
    title: "Toggle Fast Furigana",
    contexts: ["page", "selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
  if (info.menuItemId === "fast-furigana" && tab?.id) {
    toggleActiveTab(tab.id);
  }
});

chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
  if (tab?.id) {
    toggleActiveTab(tab.id);
  }
});

chrome.commands.onCommand.addListener((command: string) => {
  if (command === "toggle-furigana") {
    toggleActiveTab();
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: { ok: boolean; result?: unknown; error?: string }) => void
  ) => {
    if (message.type === "state_changed" && sender.tab?.id) {
      updateBadgeState(sender.tab.id, message.active);
      return false;
    }

    if (message.type === "convert_batch" || message.type === "convert" || message.type === "ping") {
      sendToOffscreen(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return false;
  }
);
