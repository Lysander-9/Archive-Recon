import { rm } from "node:fs/promises";

for (const target of ["dist", "release", "test-results", "playwright-report"]) {
  await rm(target, { recursive: true, force: true });
}
console.log("clean complete");
