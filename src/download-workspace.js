import path from "node:path";
import { access, mkdir, readdir, rename, stat } from "node:fs/promises";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const downloadFamilyPattern = (canonicalName, { includePartial = false } = {}) => {
  const parsed = path.parse(canonicalName);
  const partial = includePartial ? "(?:\\.crdownload)?" : "";
  return new RegExp(`^${escapeRegex(parsed.name)}(?:\\s*\\(\\d+\\))?${escapeRegex(parsed.ext)}${partial}$`, "i");
};

const listFamilyFiles = async (downloadDir, canonicalName, options) => {
  const pattern = downloadFamilyPattern(canonicalName, options);
  const entries = await readdir(downloadDir, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const filePath = path.join(downloadDir, entry.name);
    const details = await stat(filePath);
    matches.push({
      name: entry.name,
      path: filePath,
      size: details.size,
      mtimeMs: details.mtimeMs,
      ino: details.ino
    });
  }
  return matches.sort((left, right) => left.name.localeCompare(right.name));
};

const pathExists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const runIdFor = (now) => now.toISOString().replace(/[:.]/g, "-");

export const prepareDownloadWorkspace = async ({ root, reportDate, downloadDir, canonicalNames, now = new Date() }) => {
  const runId = runIdFor(now);
  const runDir = path.join(root, "runs", reportDate, runId, "downloads");
  const quarantineDir = path.join(root, "quarantine", runId);
  await mkdir(runDir, { recursive: true });
  await mkdir(quarantineDir, { recursive: true });

  const quarantined = [];
  const seen = new Set();
  for (const canonicalName of canonicalNames) {
    const matches = await listFamilyFiles(downloadDir, canonicalName, { includePartial: true });
    for (const match of matches) {
      if (seen.has(match.path)) continue;
      seen.add(match.path);
      const destination = path.join(quarantineDir, match.name);
      if (await pathExists(destination)) {
        throw new Error(`Quarantine safety stop: destination already exists (${match.name})`);
      }
      await rename(match.path, destination);
      quarantined.push({
        canonicalName,
        originalName: match.name,
        source: match.path,
        destination
      });
    }
  }

  return { runId, runDir, quarantineDir, quarantined };
};

export const captureDownloadSnapshot = async (downloadDir, canonicalName) => {
  const matches = await listFamilyFiles(downloadDir, canonicalName, { includePartial: false });
  return new Map(matches.map((match) => [match.name, match]));
};

const isFresh = (candidate, before, startedAtMs) => {
  const previous = before.get(candidate.name);
  const changed = !previous || previous.ino !== candidate.ino || previous.size !== candidate.size || previous.mtimeMs !== candidate.mtimeMs;
  return changed && candidate.mtimeMs >= startedAtMs - 2_000;
};

export const waitForFreshStableDownload = async ({
  downloadDir,
  canonicalName,
  before,
  startedAtMs,
  timeoutMs,
  pollIntervalMs,
  stableChecksRequired = 3,
  sleep
}) => {
  const started = Date.now();
  let trackedPath = null;
  let previousSize = null;
  let stableChecks = 0;

  while (Date.now() - started < timeoutMs) {
    const candidates = (await listFamilyFiles(downloadDir, canonicalName, { includePartial: false }))
      .filter((candidate) => isFresh(candidate, before, startedAtMs));

    if (candidates.length > 1) {
      throw new Error(`Download safety stop: multiple new candidates detected for ${canonicalName} (${candidates.map(({ name }) => name).join(", ")})`);
    }

    const candidate = candidates[0];
    if (!candidate || candidate.size <= 0) {
      trackedPath = null;
      previousSize = null;
      stableChecks = 0;
    } else if (candidate.path === trackedPath && candidate.size === previousSize) {
      stableChecks += 1;
      if (stableChecks >= stableChecksRequired) return candidate;
    } else {
      trackedPath = candidate.path;
      previousSize = candidate.size;
      stableChecks = 0;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Download did not complete with one fresh stable file: ${canonicalName}`);
};

export const moveDownloadIntoRun = async ({ candidate, runDir, canonicalName }) => {
  const destination = path.join(runDir, canonicalName);
  if (await pathExists(destination)) {
    throw new Error(`Run workspace safety stop: destination already exists (${canonicalName})`);
  }
  await rename(candidate.path, destination);
  return destination;
};
