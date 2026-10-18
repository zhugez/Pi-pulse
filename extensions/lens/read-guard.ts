import * as path from "node:path";
import { existsSync } from "node:fs";

export class ReadGuardTracker {
  private readFiles = new Set<string>();

  normalize(targetPath: string, cwd = process.cwd()): string {
    const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
    return path.normalize(resolved);
  }

  markRead(targetPath: string, cwd = process.cwd()): void {
    const norm = this.normalize(targetPath, cwd);
    this.readFiles.add(norm);
  }

  isRead(targetPath: string, cwd = process.cwd()): boolean {
    const norm = this.normalize(targetPath, cwd);
    return this.readFiles.has(norm);
  }

  checkEdit(targetPath: string, cwd = process.cwd()): string | undefined {
    const norm = this.normalize(targetPath, cwd);
    // If file does not exist yet (creating new file with write tool), read-guard does not block
    if (!existsSync(norm)) {
      return undefined;
    }
    if (!this.readFiles.has(norm)) {
      return `[read-guard] Note: '${path.relative(cwd, norm)}' was modified without prior read in this session. Verify lines to avoid accidental overwrite.`;
    }
    return undefined;
  }

  clear(): void {
    this.readFiles.clear();
  }

  size(): number {
    return this.readFiles.size;
  }
}
