import React from "react";
import ReactDOM from "react-dom/client";
import ShellApp from "./shell/routes/App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ShellApp />
  </React.StrictMode>
);
