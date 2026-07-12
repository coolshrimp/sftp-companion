import { minimatch } from 'minimatch';
import { isChildOrSame, normalizeRelative } from './pathUtils';

export class IgnoreMatcher {
  public constructor(
    private readonly ignorePatterns: string[],
    private readonly whitelist: string[]
  ) {}

  public isIgnored(relativePath: string): boolean {
    const normalized = normalizeRelative(relativePath);
    if (!normalized) {
      return false;
    }
    // Match the path itself and every ancestor folder, so a plain folder entry
    // like "HostedSites" also ignores everything inside it.
    const segments = normalized.split('/');
    const candidates: string[] = [];
    for (let index = 1; index <= segments.length; index += 1) {
      candidates.push(segments.slice(0, index).join('/'));
    }
    return this.ignorePatterns.some((pattern) => {
      const normalizedPattern = normalizeRelative(pattern);
      if (!normalizedPattern) {
        return false;
      }
      // Gitignore-style semantics:
      //  - a trailing "/**" also covers the folder itself ("x/**" ⇒ "x"),
      //  - a pattern without a slash matches at ANY depth ("_notes" ignores
      //    every _notes folder in the tree, like .gitignore does),
      //  - a pattern with a slash stays anchored to the sync root.
      const base = normalizedPattern.replace(/\/\*\*$/, '');
      const variants = base.includes('/') ? [base] : [base, `**/${base}`];
      return candidates.some((candidate) => variants.some((variant) => minimatch(candidate, variant, { dot: true })));
    });
  }

  public isAllowed(relativePath: string): boolean {
    const normalized = normalizeRelative(relativePath);
    if (!normalized) {
      return true;
    }
    if (this.whitelist.length === 0) {
      return !this.isIgnored(normalized);
    }
    const allowed = this.whitelist.some((entry) => isChildOrSame(normalized, entry) || isChildOrSame(entry, normalized));
    return allowed && !this.isIgnored(normalized);
  }
}
