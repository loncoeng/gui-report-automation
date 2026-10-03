import assert from "node:assert/strict";
import test from "node:test";
import { decideDriveUploadRecovery } from "../src/drive-upload-recovery.js";

test("a missing Drive file retries only after the first failed chooser attempt", () => {
  assert.equal(decideDriveUploadRecovery({ count: 0, attempt: 1 }), "retry-once");
});

test("an exact Drive file is accepted without uploading it again", () => {
  assert.equal(decideDriveUploadRecovery({ count: 1, attempt: 1 }), "already-uploaded");
  assert.equal(decideDriveUploadRecovery({ count: 1, attempt: 2 }), "already-uploaded");
});

test("a second missing result stops instead of looping", () => {
  assert.equal(decideDriveUploadRecovery({ count: 0, attempt: 2 }), "stop");
});

test("duplicates and invalid API counts fail closed", () => {
  assert.throws(
    () => decideDriveUploadRecovery({ count: 2, attempt: 1 }),
    /duplicate exact files=2/
  );
  assert.throws(
    () => decideDriveUploadRecovery({ count: -1, attempt: 1 }),
    /invalid exact-file count/
  );
});
