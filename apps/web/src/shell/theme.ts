// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
export type Theme = "light" | "dark";
const KEY = "sa.theme";

export function getTheme(): Theme {
  return document.body.classList.contains("theme-dark") ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
  document.body.classList.toggle("theme-dark", theme === "dark");
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage may be unavailable; the theme still applies for this page
  }
}

/** Applies the saved theme; call once at start-up. */
export function initTheme(): void {
  try {
    if (localStorage.getItem(KEY) === "dark") document.body.classList.add("theme-dark");
  } catch {
    // keep the light default
  }
}
