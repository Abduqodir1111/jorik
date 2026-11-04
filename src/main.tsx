import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
import "./operator.css";
import { OperatorProvider } from "./OperatorContext";
createRoot(document.getElementById("root")!).render(
  <OperatorProvider>
    <App />
  </OperatorProvider>,
);

import "./orders.css";

import "./unified.css";

import "./order-form.css";
