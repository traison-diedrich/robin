import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSidekickCommand } from "./src/command.ts";
import { registerMain } from "./src/main.ts";
import { NestedSessions } from "./src/sessions.ts";
import { registerSidekick } from "./src/sidekick.ts";

export default function robin(pi: ExtensionAPI): void {
  const store = new NestedSessions();
  registerSidekickCommand(pi, store);
  registerSidekick(pi, store);
  registerMain(pi);
}
