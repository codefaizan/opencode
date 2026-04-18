import { mkdir, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"

const root = process.cwd()
const proposedFiles = (await readdir(root)).filter((name) => /^vscode\.proposed\..+\.d\.ts$/.test(name))

if (proposedFiles.length === 0) {
  console.log("No vscode.proposed.*.d.ts files found in project root. Run `npx @vscode/dts dev` first.")
  process.exit(0)
}

const targetDir = path.join(root, "src", "types")
await mkdir(targetDir, { recursive: true })

await Promise.all(
  proposedFiles.map(async (name) => {
    const source = path.join(root, name)
    const target = path.join(targetDir, name)
    await rm(target, { force: true })
    await rename(source, target)
  }),
)

console.log(`Moved ${proposedFiles.length} proposed API definition file${proposedFiles.length === 1 ? "" : "s"} to src/types/.`)
