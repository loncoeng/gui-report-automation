import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const createLogger = async (logDir) => {
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return async (event, details = {}) => {
    const record = { at: new Date().toISOString(), event, ...details };
    await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
    console.log(JSON.stringify(record));
  };
};
