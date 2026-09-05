import { Command } from "commander";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { registerBridgeCommands } from "./bridge-commands.js";
import { registerSessionCommands } from "./session-commands.js";
import { registerTunnelCommands } from "./tunnel-commands.js";
import { registerWorkspaceCommands } from "./workspace-commands.js";

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name("c2c")
    .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
    .version(VERSION, "-v, --version")
    .configureHelp({ sortSubcommands: true });
  registerBridgeCommands(program);
  registerWorkspaceCommands(program);
  registerSessionCommands(program);
  registerTunnelCommands(program);
  return program;
}
