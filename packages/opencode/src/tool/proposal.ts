import { pathToFileURL } from "url"
import z from "zod"

export const ProposalFile = z.object({
  operation: z.enum(["set", "delete"]),
  file_path: z.string(),
  uri: z.string(),
  new_content: z.string().optional(),
  diff: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
})
export type ProposalFile = z.infer<typeof ProposalFile>

export const ProposalPayload = z.object({
  mode: z.literal("propose"),
  files: ProposalFile.array(),
  stats: z
    .object({
      files: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    })
    .optional(),
})
export type ProposalPayload = z.infer<typeof ProposalPayload>

export function setFile(input: {
  filePath: string
  newContent: string
  diff?: string
  additions?: number
  deletions?: number
}): ProposalFile {
  return {
    operation: "set",
    file_path: input.filePath,
    uri: pathToFileURL(input.filePath).href,
    new_content: input.newContent,
    diff: input.diff,
    additions: input.additions,
    deletions: input.deletions,
  }
}

export function deleteFile(input: {
  filePath: string
  diff?: string
  additions?: number
  deletions?: number
}): ProposalFile {
  return {
    operation: "delete",
    file_path: input.filePath,
    uri: pathToFileURL(input.filePath).href,
    diff: input.diff,
    additions: input.additions,
    deletions: input.deletions,
  }
}

export function payload(files: ProposalFile[]): ProposalPayload {
  return {
    mode: "propose",
    files,
    stats: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
  }
}

export * as Proposal from "./proposal"