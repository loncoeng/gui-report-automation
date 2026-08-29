import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const loadConfig = async () => {
  const configPath = process.env.AUTOMATION_CONFIG || path.resolve(here, "../config/automation.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));

  return config;
};

export const tokyoDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
};

export const reportingDate = (date = new Date()) => {
  const tokyo = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  tokyo.setDate(tokyo.getDate() - 1);
  return `${tokyo.getFullYear()}-${String(tokyo.getMonth() + 1).padStart(2, "0")}-${String(tokyo.getDate()).padStart(2, "0")}`;
};
