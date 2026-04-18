import z from "zod"

export const ExecutionMode = z.enum(["direct", "propose"])
export type ExecutionMode = z.infer<typeof ExecutionMode>

export function resolveExecutionMode(mode: ExecutionMode | undefined): ExecutionMode {
  return mode ?? "direct"
}

export * as SessionExecutionMode from "./execution-mode"