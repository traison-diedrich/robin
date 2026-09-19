import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAIN_PROMPT = fs.readFileSync(new URL("./main.md", import.meta.url), "utf8").trim();
function applyMainTools(pi: ExtensionAPI): void {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const tools = new Set(pi.getActiveTools());
  for (const tool of ["read", "grep", "find", "ls", "bash", "sidekick"]) {
    if (available.has(tool)) tools.add(tool);
  }
  tools.delete("edit");
  tools.delete("write");
  pi.setActiveTools([...tools]);
}

export function registerMain(pi: ExtensionAPI): void {
  const activate = (): void => {
    applyMainTools(pi);
  };

  pi.on("session_start", activate);
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${MAIN_PROMPT}`,
  }));
}
