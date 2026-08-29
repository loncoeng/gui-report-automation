const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const iamCredentialsBaseUrl = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";
const driveApiFilesUrl = "https://www.googleapis.com/drive/v3/files";
const driveMetadataReadonlyScope = "https://www.googleapis.com/auth/drive.metadata.readonly";

const requestJson = async ({ fetchImpl, url, options, timeoutMs, label }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timed out" : "request failed";
    throw new Error(`Drive cleanup audit unavailable: ${label} ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Drive cleanup audit unavailable: ${label} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Drive cleanup audit unavailable: ${label} returned invalid JSON`);
  }
};

const obtainImpersonatedToken = async ({ fetchImpl, auth }) => {
  if (auth?.mode !== "gce-service-account-impersonation" ||
      !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(auth.targetServiceAccount || "")) {
    throw new Error("Drive cleanup audit unavailable: invalid keyless authentication configuration");
  }

  const timeoutMs = auth.requestTimeoutMs ?? 20_000;
  const sourceToken = await requestJson({
    fetchImpl,
    url: metadataTokenUrl,
    options: { headers: { "Metadata-Flavor": "Google" } },
    timeoutMs,
    label: "metadata token request"
  });
  if (!sourceToken?.access_token) {
    throw new Error("Drive cleanup audit unavailable: metadata token response was incomplete");
  }

  const target = encodeURIComponent(auth.targetServiceAccount);
  const impersonated = await requestJson({
    fetchImpl,
    url: `${iamCredentialsBaseUrl}/${target}:generateAccessToken`,
    options: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sourceToken.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        scope: [driveMetadataReadonlyScope],
        lifetime: `${auth.tokenLifetimeSeconds ?? 600}s`
      })
    },
    timeoutMs,
    label: "service account impersonation"
  });
  if (!impersonated?.accessToken) {
    throw new Error("Drive cleanup audit unavailable: impersonated token response was incomplete");
  }
  return impersonated.accessToken;
};

const escapeDriveQueryLiteral = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export const readDriveExactFileCounts = async ({
  folderId,
  filenames,
  auth,
  fetchImpl = globalThis.fetch
}) => {
  if (!folderId || !Array.isArray(filenames) || filenames.length === 0 ||
      filenames.some((name) => !name || typeof name !== "string") ||
      typeof fetchImpl !== "function") {
    throw new Error("Drive cleanup audit unavailable: invalid verification inputs");
  }

  const uniqueNames = [...new Set(filenames)];
  const token = await obtainImpersonatedToken({ fetchImpl, auth });
  const timeoutMs = auth.requestTimeoutMs ?? 20_000;
  const folderQuery = new URLSearchParams({
    fields: "id,name,mimeType,trashed",
    supportsAllDrives: "true"
  });
  const folder = await requestJson({
    fetchImpl,
    url: `${driveApiFilesUrl}/${encodeURIComponent(folderId)}?${folderQuery}`,
    options: { headers: { Authorization: `Bearer ${token}` } },
    timeoutMs,
    label: "Drive API folder access check"
  });
  if (folder?.id !== folderId || folder?.mimeType !== "application/vnd.google-apps.folder" ||
      folder?.trashed === true) {
    throw new Error("Drive cleanup audit unavailable: configured folder was not verified");
  }

  const nameClause = uniqueNames
    .map((name) => `name = '${escapeDriveQueryLiteral(name)}'`)
    .join(" or ");
  const query = new URLSearchParams({
    q: `'${escapeDriveQueryLiteral(folderId)}' in parents and trashed = false and (${nameClause})`,
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    pageSize: "100",
    fields: "files(id,name,parents,trashed),nextPageToken"
  });
  const result = await requestJson({
    fetchImpl,
    url: `${driveApiFilesUrl}?${query}`,
    options: { headers: { Authorization: `Bearer ${token}` } },
    timeoutMs,
    label: "Drive API exact-file query"
  });
  if (result?.nextPageToken) {
    throw new Error("Drive cleanup audit unavailable: exact-file query exceeded one page");
  }

  const approved = new Set(uniqueNames);
  const counts = Object.fromEntries(uniqueNames.map((name) => [name, 0]));
  for (const file of Array.isArray(result?.files) ? result.files : []) {
    if (file?.trashed === true || !approved.has(file?.name) ||
        !Array.isArray(file?.parents) || !file.parents.includes(folderId)) continue;
    counts[file.name] += 1;
  }

  return {
    source: "drive-api-keyless-impersonation",
    folderId,
    counts,
    remainingCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
    verifiedAbsent: Object.values(counts).every((count) => count === 0)
  };
};
