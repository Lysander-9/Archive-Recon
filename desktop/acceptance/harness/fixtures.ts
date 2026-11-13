import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ACCEPTANCE_ROOT = path.resolve(HERE, "..");
export const DESKTOP_ROOT = path.resolve(ACCEPTANCE_ROOT, "..");
export const REPO_ROOT = path.resolve(DESKTOP_ROOT, "..");

export interface ManifestEntry {
  path: string;
  sha256: string;
  provenance: string;
}

export interface FixtureManifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

export function fixturePath(...parts: string[]): string {
  return path.join(ACCEPTANCE_ROOT, "fixtures", ...parts);
}

export function readFixtureBytes(...parts: string[]): Buffer {
  return readFileSync(fixturePath(...parts));
}

export function readFixtureText(...parts: string[]): string {
  return readFixtureBytes(...parts).toString("utf8");
}

export function readFixtureJson<T = unknown>(...parts: string[]): T {
  return JSON.parse(readFixtureText(...parts)) as T;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function loadManifest(): FixtureManifest {
  return readFixtureJson<FixtureManifest>("manifest.json");
}

export function repoFileExists(...parts: string[]): boolean {
  return existsSync(path.join(REPO_ROOT, ...parts));
}

export function desktopFile(...parts: string[]): string {
  return path.join(DESKTOP_ROOT, ...parts);
}
