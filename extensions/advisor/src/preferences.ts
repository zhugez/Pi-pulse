import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { redactAndCapText } from "./redaction.ts";

const PREFERENCES_MAX_BYTES = 8 * 1024;

// Keep local filename components separate from Socket's URL-string heuristic.
const PREFERENCES_FILENAME = ["advisor-preferences", "md"].join(".");
const AGENTS_FILENAME = "AGENTS.md";

export interface TextAttachment {
  bytes: number;
  text: string;
}

export interface ProjectRulesAttachment {
  bytes: number;
  global?: TextAttachment;
  project?: TextAttachment;
  withheldReason?: "untrusted";
}

const inside = (root: string, candidate: string) => {
  const path = relative(root, candidate);

  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

const hasSymlinkBelow = async (rootCandidate: string, candidate: string) => {
  const root = resolve(rootCandidate);
  const target = resolve(candidate);

  if (!inside(root, target)) {
    return true;
  }

  let current = root;

  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stats = await lstat(current);

    if (stats.isSymbolicLink()) {
      return true;
    }
  }

  return false;
};

const readTrustedText = async (
  candidate: string,
  rootCandidate: string,
  maxBytes: number,
  redact: boolean
): Promise<TextAttachment | undefined> => {
  if (maxBytes <= 0) {
    return;
  }

  try {
    const root = await realpath(rootCandidate);

    if (await hasSymlinkBelow(rootCandidate, candidate)) {
      return;
    }

    const stats = await lstat(candidate);

    if (stats.isSymbolicLink() || !stats.isFile()) {
      return;
    }

    const resolved = await realpath(candidate);

    if (!inside(root, resolved)) {
      return;
    }

    if (await hasSymlinkBelow(rootCandidate, candidate)) {
      return;
    }

    const flags = constants.O_NOFOLLOW
      ? constants.O_RDONLY + constants.O_NOFOLLOW
      : constants.O_RDONLY;

    const file = await open(resolved, flags);

    try {
      const opened = await file.stat();

      if (
        !opened.isFile() ||
        opened.dev !== stats.dev ||
        opened.ino !== stats.ino
      ) {
        return;
      }

      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const source = buffer.subarray(0, bytesRead).toString("utf-8");
      const capped = redactAndCapText(source, maxBytes, redact);

      return { bytes: Buffer.byteLength(capped, "utf-8"), text: capped };
    } finally {
      await file.close();
    }
  } catch {
    // Missing, unreadable, or unsafe files are intentionally withheld.
  }
};

export const readProjectPreferences = (
  ctx: ExtensionContext,
  maxBytes = PREFERENCES_MAX_BYTES,
  redact = true
): Promise<TextAttachment | undefined> => {
  if (!ctx.isProjectTrusted()) {
    return Promise.resolve(undefined);
  }

  return readTrustedText(
    join(ctx.cwd, ".pi", PREFERENCES_FILENAME),
    ctx.cwd,
    maxBytes,
    redact
  );
};

export const readProjectRules = async (
  ctx: ExtensionContext,
  maxBytes = PREFERENCES_MAX_BYTES,
  redact = true
): Promise<ProjectRulesAttachment> => {
  if (!ctx.isProjectTrusted()) {
    return { bytes: 0, withheldReason: "untrusted" };
  }

  const project = await readTrustedText(
    join(ctx.cwd, AGENTS_FILENAME),
    ctx.cwd,
    maxBytes,
    redact
  );

  const remaining = Math.max(0, maxBytes * 2 - (project?.bytes ?? 0));

  const global = await readTrustedText(
    join(getAgentDir(), AGENTS_FILENAME),
    getAgentDir(),
    Math.min(maxBytes, remaining),
    redact
  );

  return {
    bytes: (project?.bytes ?? 0) + (global?.bytes ?? 0),
    global,
    project,
  };
};
