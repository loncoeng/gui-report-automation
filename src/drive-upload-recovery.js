export const decideDriveUploadRecovery = ({ count, attempt, maxAttempts = 2 }) => {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Drive upload recovery safety stop: invalid exact-file count=${count}`);
  }
  if (!Number.isInteger(attempt) || attempt < 1 ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || attempt > maxAttempts) {
    throw new Error("Drive upload recovery safety stop: invalid attempt bounds");
  }
  if (count > 1) {
    throw new Error(`Drive upload recovery safety stop: duplicate exact files=${count}`);
  }
  if (count === 1) return "already-uploaded";
  if (attempt < maxAttempts) return "retry-once";
  return "stop";
};
