import { emptyWorkspace, STORAGE_KEY } from "./workspace.js";

export async function getWorkspace() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? emptyWorkspace();
}

export function watchWorkspace(listener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && STORAGE_KEY in changes) {
      listener(changes[STORAGE_KEY].newValue ?? emptyWorkspace());
    }
  });
}

export async function saveWorkspace(revision, change) {
  const response = await chrome.runtime.sendMessage({ ...change, type: "ledger-write", revision });
  if (!response?.ok) throw new Error(response?.error ?? "保存未完成，请刷新后重试。");
  return response.workspace;
}

export function download(name, type, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
