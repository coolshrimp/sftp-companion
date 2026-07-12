import * as path from 'path';

export function normalizeRelative(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  return normalized.replace(/\/+/g, '/').replace(/\/$/, '');
}

export function joinRemote(...parts: string[]): string {
  const merged = parts.filter(Boolean).map((part) => normalizeRelative(part)).join('/');
  return `/${merged}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function isChildOrSame(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizeRelative(candidate);
  const normalizedParent = normalizeRelative(parent);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

export function relativeTo(basePath: string, targetPath: string): string {
  return normalizeRelative(toPosix(path.relative(basePath, targetPath)));
}
