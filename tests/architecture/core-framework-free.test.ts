import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const coreDir = join(import.meta.dirname, "..", "..", "packages", "core");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("core package", () => {
  it("imports nothing from Next.js (or React)", () => {
    const files = sourceFiles(join(coreDir, "src"));
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) =>
      /(from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](next|react|react-dom)(\/[^"']*)?["']/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("declares no dependency on Next.js or React", () => {
    const manifest = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    });
    expect(declared.filter((name) => ["next", "react", "react-dom"].includes(name))).toEqual([]);
  });
});
