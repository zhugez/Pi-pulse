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

  checkPreModification(targetPath: string, cwd = process.cwd()): { wasExisting: boolean; shouldWarn: boolean } {
    const norm = this.normalize(targetPath, cwd);
    const wasExisting = existsSync(norm);
    const shouldWarn = wasExisting && !this.readFiles.has(norm);
    return { wasExisting, shouldWarn };
  }

  clear(): void {
    this.readFiles.clear();
  }

  size(): number {
    return this.readFiles.size;
  }
}
