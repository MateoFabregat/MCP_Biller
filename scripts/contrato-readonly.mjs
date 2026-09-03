#!/usr/bin/env node
// Harness de evidencia externa: exclusivamente GET contra test.biller.uy.
import { runReadonlyContract } from "./lib/contratoReadonly.mjs";

try {
  const result = await runReadonlyContract();
  console.log(result.skipped
    ? `Contrato read-only: skip — ${result.reason}`
    : `Contrato read-only: evidencia externa pendiente de interpretación en ${result.artifactPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
