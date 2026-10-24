import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PresenterPage } from "./pages/PresenterPage";
import { initTheme } from "./shell/theme";
import "./styles.css";

initTheme();
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>{location.pathname === "/presenter" ? <PresenterPage /> : <App />}</StrictMode>,
);
