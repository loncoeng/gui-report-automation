import assert from "node:assert/strict";
import test from "node:test";
import { readDriveExactFileCounts } from "../src/drive-verification.js";

const auth = {
  mode: "gce-service-account-impersonation",
  targetServiceAccount: "reader@example-project.iam.gserviceaccount.com",
  tokenLifetimeSeconds: 600,
  requestTimeoutMs: 1_000
};

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

const successfulFetch = (files, requests = []) => async (url, options = {}) => {
  requests.push({ url: String(url), options });
  if (String(url).startsWith("http://metadata.google.internal/")) {
    return jsonResponse({ access_token: "metadata-token" });
  }
  if (String(url).startsWith("https://iamcredentials.googleapis.com/")) {
    return jsonResponse({ accessToken: "impersonated-token" });
  }
  if (/\/drive\/v3\/files\/report-folder\?/.test(String(url))) {
    return jsonResponse({
      id: "report-folder",
      name: "レポート保存",
      mimeType: "application/vnd.google-apps.folder",
      trashed: false
    });
  }
  return jsonResponse({ files });
};

test("Drive audit scopes exact names to the configured folder and non-trashed files", async () => {
  const folderId = "report-folder";
  const filenames = [
    "ContractSummary_JP_2026-08.csv",
    "ContractSummary_JP_2026-08-27.csv"
  ];
  const requests = [];
  const result = await readDriveExactFileCounts({
    folderId,
    filenames,
    auth,
    fetchImpl: successfulFetch([
      { id: "monthly", name: filenames[0], parents: [folderId], trashed: false },
      { id: "daily-1", name: filenames[1], parents: [folderId], trashed: false },
      { id: "daily-2", name: filenames[1], parents: [folderId], trashed: false },
      { id: "other-folder", name: filenames[0], parents: ["other"], trashed: false },
      { id: "trash", name: filenames[0], parents: [folderId], trashed: true },
      { id: "suffix", name: `${filenames[1]}.gz`, parents: [folderId], trashed: false }
    ], requests)
  });

  assert.deepEqual(result.counts, {
    [filenames[0]]: 1,
    [filenames[1]]: 2
  });
  assert.equal(result.remainingCount, 3);
  assert.equal(result.verifiedAbsent, false);
  assert.equal(requests.length, 4);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    scope: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
    lifetime: "600s"
  });
  assert.match(requests[2].url, /\/drive\/v3\/files\/report-folder\?/);
  const driveUrl = new URL(requests[3].url);
  assert.match(driveUrl.searchParams.get("q"), /'report-folder' in parents/);
  assert.match(driveUrl.searchParams.get("q"), /trashed = false/);
  assert.match(driveUrl.searchParams.get("q"), /name = 'ContractSummary_JP_2026-08\.csv'/);
  assert.match(driveUrl.searchParams.get("q"), /name = 'ContractSummary_JP_2026-08-27\.csv'/);
});

test("Drive audit approves cleanup only when every exact name is absent", async () => {
  const result = await readDriveExactFileCounts({
    folderId: "report-folder",
    filenames: ["monthly.csv", "daily.csv"],
    auth,
    fetchImpl: successfulFetch([])
  });

  assert.deepEqual(result.counts, { "monthly.csv": 0, "daily.csv": 0 });
  assert.equal(result.remainingCount, 0);
  assert.equal(result.verifiedAbsent, true);
});

test("Drive audit distinguishes API failure from an empty folder", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("metadata.google.internal")) {
      return jsonResponse({ access_token: "metadata-token" });
    }
    if (String(url).includes("iamcredentials.googleapis.com")) {
      return jsonResponse({ accessToken: "impersonated-token" });
    }
    return jsonResponse({ error: "Drive API disabled" }, 403);
  };

  await assert.rejects(
    readDriveExactFileCounts({
      folderId: "report-folder",
      filenames: ["monthly.csv", "daily.csv"],
      auth,
      fetchImpl
    }),
    /Drive cleanup audit unavailable: Drive API folder access check returned HTTP 403/
  );
});

test("Drive audit cannot report zero when the configured folder is not visible", async () => {
  const requests = [];
  const fetchImpl = successfulFetch([], requests);
  const hiddenFolderFetch = async (url, options) => {
    if (/\/drive\/v3\/files\/report-folder\?/.test(String(url))) {
      return jsonResponse({ error: "not found" }, 404);
    }
    return fetchImpl(url, options);
  };

  await assert.rejects(
    readDriveExactFileCounts({
      folderId: "report-folder",
      filenames: ["monthly.csv", "daily.csv"],
      auth,
      fetchImpl: hiddenFolderFetch
    }),
    /Drive API folder access check returned HTTP 404/
  );
});

test("Drive audit rejects missing keyless auth instead of returning zero", async () => {
  await assert.rejects(
    readDriveExactFileCounts({
      folderId: "report-folder",
      filenames: ["monthly.csv"],
      auth: {},
      fetchImpl: successfulFetch([])
    }),
    /invalid keyless authentication configuration/
  );
});
