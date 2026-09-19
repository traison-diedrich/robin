import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAIN_PROMPT = fs.readFileSync(new URL("./main.md", import.meta.url), "utf8").trim();
const MAIN_TOOLS = ["read", "grep", "find", "ls", "bash", "sidekick"];

function applyMainTools(pi: ExtensionAPI): void {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  pi.setActiveTools(MAIN_TOOLS.filter((tool) => available.has(tool)));
}

export function registerMain(pi: ExtensionAPI): void {
  const activate = (): void => {
    applyMainTools(pi);
  };

  pi.on("session_start", activate);
  pi.on("session_tree", activate);
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${MAIN_PROMPT}`,
  }));
}
