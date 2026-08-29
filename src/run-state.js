import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const statePathFor = (root, reportDate) => path.join(root, "state", `${reportDate}.json`);

const writeJsonAtomic = async (filePath, value) => {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
};

export const readDailyRun = async (root, reportDate) => {
  const filePath = statePathFor(root, reportDate);
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

export const beginDailyRun = async (root, reportDate, now = new Date()) => {
  const stateDir = path.join(root, "state");
  const filePath = statePathFor(root, reportDate);
  await mkdir(stateDir, { recursive: true });

  const record = {
    reportDate,
    status: "started",
    stage: "safety_checks_passed",
    startedAt: now.toISOString(),
    updatedAt: now.toISOString()
  };

  let handle;
  try {
    handle = await open(filePath, "wx");
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = await readDailyRun(root, reportDate);
      throw new Error(
        `Daily run already attempted for ${reportDate}: status=${existing?.status || "unknown"}, stage=${existing?.stage || "unknown"}`
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }

  return filePath;
};

export const updateDailyRun = async (filePath, patch, now = new Date()) => {
  const current = JSON.parse(await readFile(filePath, "utf8"));
  const next = { ...current, ...patch, updatedAt: now.toISOString() };
  await writeJsonAtomic(filePath, next);
  return next;
};

export const completeDailyRun = (filePath, details = {}, now = new Date()) =>
  updateDailyRun(filePath, { ...details, status: "completed", stage: "completed", completedAt: now.toISOString() }, now);

export const failDailyRun = (filePath, error, now = new Date()) =>
  updateDailyRun(
    filePath,
    {
      status: "failed",
      failedAt: now.toISOString(),
      error: error instanceof Error ? error.message : String(error)
    },
    now
  );
