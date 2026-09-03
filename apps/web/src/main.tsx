import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { BackendGate } from "./components/BackendGate";
import "./styles/tokens.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      {/* 环境守门员：后端未就绪时渲染引导页而非错乱页面（首启体验保护） */}
      <BackendGate>
        <App />
      </BackendGate>
    </BrowserRouter>
  </StrictMode>,
);
