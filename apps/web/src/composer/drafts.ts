const keyOf = (user: string, chat: string, root?: string) =>
  `sa.draft.${user}.${chat}${root ? `.${root}` : ""}`;

export const loadDraft = (user: string, chat: string, root?: string): string =>
  localStorage.getItem(keyOf(user, chat, root)) ?? "";

export function saveDraft(user: string, chat: string, root: string | undefined, text: string) {
  const k = keyOf(user, chat, root);
  if (text) localStorage.setItem(k, text);
  else localStorage.removeItem(k);
}
