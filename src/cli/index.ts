import { createCliProgram } from "./program.js";
import { cross } from "./shared.js";

createCliProgram().parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
