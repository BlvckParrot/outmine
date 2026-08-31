import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { startObserving } from "./observability";
import "./index.css";

// Before the first render, or the handlers are not installed for the thing most likely
// to need them - a render that throws on the way up. Does nothing unless the server
// wrote settings into the page.
startObserving();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
