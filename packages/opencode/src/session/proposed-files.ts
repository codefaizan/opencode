import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect } from "effect"
import path from "path"

export namespace SessionProposedFiles {
  export type Entry =
    | {
        type: "file"
        content: string
      }
    | {
        type: "delete"
      }

  export interface Run {
    readonly entries: Map<string, Entry>
  }

  export function create(): Run {
    return {
      entries: new Map<string, Entry>(),
    }
  }

  export function normalizePath(filepath: string): string {
    return AppFileSystem.resolve(filepath)
  }

  export function get(run: Run | undefined, filepath: string): Entry | undefined {
    if (!run) return
    return run.entries.get(normalizePath(filepath))
  }

  export function setFile(run: Run, filepath: string, content: string) {
    run.entries.set(normalizePath(filepath), {
      type: "file",
      content,
    })
  }

  export function setDelete(run: Run, filepath: string) {
    run.entries.set(normalizePath(filepath), {
      type: "delete",
    })
  }

  export function exists(run: Run | undefined, fs: AppFileSystem.Interface, filepath: string): Effect.Effect<boolean> {
    return Effect.gen(function* () {
      const entry = get(run, filepath)
      if (entry?.type === "file") return true
      if (entry?.type === "delete") return false
      return yield* fs.existsSafe(filepath)
    })
  }

  export function readFileString(run: Run | undefined, fs: AppFileSystem.Interface, filepath: string) {
    return Effect.gen(function* () {
      const entry = get(run, filepath)
      if (entry?.type === "file") return entry.content
      if (entry?.type === "delete") {
        return yield* Effect.fail(new Error(`File not found: ${filepath}`))
      }
      return yield* fs.readFileString(filepath)
    })
  }

  export function hasChildren(run: Run | undefined, dirpath: string): boolean {
    if (!run) return false
    const target = normalizePath(dirpath)
    for (const [filepath, entry] of run.entries) {
      if (entry.type === "delete") continue
      if (path.dirname(filepath) === target) return true
    }
    return false
  }

  export function listDirectoryEntries(
    run: Run | undefined,
    fs: AppFileSystem.Interface,
    dirpath: string,
  ): Effect.Effect<AppFileSystem.DirEntry[]> {
    return Effect.gen(function* () {
      const entries = new Map<string, AppFileSystem.DirEntry>()
      for (const item of yield* fs.readDirectoryEntries(dirpath).pipe(Effect.catch(() => Effect.succeed([])))) {
        entries.set(item.name, item)
      }

      if (!run) {
        return Array.from(entries.values())
      }

      const target = normalizePath(dirpath)
      for (const [filepath, entry] of run.entries) {
        if (path.dirname(filepath) !== target) continue
        const name = path.basename(filepath)
        if (entry.type === "delete") {
          entries.delete(name)
          continue
        }
        entries.set(name, {
          name,
          type: "file",
        })
      }

      return Array.from(entries.values())
    })
  }
}