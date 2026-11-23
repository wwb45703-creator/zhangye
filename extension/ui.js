export const element = (id) => document.getElementById(id);

export function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

export async function confirmAction(title, detail, okText) {
  const dialog = element("confirm-dialog");
  dialog.querySelector("[data-confirm-title]").textContent = title;
  dialog.querySelector("[data-confirm-detail]").textContent = detail;
  dialog.querySelector("[data-confirm-ok]").textContent = okText;
  dialog.returnValue = "cancel";
  const closed = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
  dialog.showModal();
  return closed;
}

const localTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
export const dateLabel = (iso) => localTime.format(new Date(iso));
