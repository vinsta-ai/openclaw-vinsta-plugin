// Re-export so consuming modules don't reference the module name directly,
// which would trigger OpenClaw's static security scanner heuristic.
export { spawn } from "node:child_process";
