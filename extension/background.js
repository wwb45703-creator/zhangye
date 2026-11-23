import { changeWorkspace, emptyWorkspace, STORAGE_KEY } from "./core/workspace.js";

const allowed = new Set(["popup.html", "workbench.html"].map((path) => chrome.runtime.getURL(path)));
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let pendingWrite = Promise.resolve();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !allowed.has(sender.url?.split(/[?#]/, 1)[0]) ||
      request?.type !== "ledger-write") return false;

  const write = pendingWrite.then(async () => {
    await storageReady;
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const next = changeWorkspace(stored[STORAGE_KEY] ?? emptyWorkspace(), request);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    sendResponse({ ok: true, workspace: next });
  });
  pendingWrite = write.catch((error) => {
    sendResponse({ ok: false, error: error.message || "保存失败，请重试。" });
  });
  return true;
});
