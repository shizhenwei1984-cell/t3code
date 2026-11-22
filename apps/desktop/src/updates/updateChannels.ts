// Preview builds share nightly branding but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function personalStableBase(version: string): string | undefined {
  return /^(\d+\.\d+\.\d+)-personal\.g[0-9a-f]+$/.exec(version)?.[1];
}

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}
