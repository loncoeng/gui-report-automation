const defaultVerification = {
  sheetName: "日次集計",
  column: "C",
  startRow: 2,
  endRow: 5
};

const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const iamCredentialsBaseUrl = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";
const sheetsApiBaseUrl = "https://sheets.googleapis.com/v4/spreadsheets";
const sheetsReadonlyScope = "https://www.googleapis.com/auth/spreadsheets.readonly";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizeDate = (value) => {
  const match = String(value ?? "").normalize("NFKC").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return match
    ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`
    : null;
};

const requestJson = async ({ fetchImpl, url, options, timeoutMs, label }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timed out" : "request failed";
    throw new Error(`Import sheet verification safety stop: ${label} ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Import sheet verification safety stop: ${label} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Import sheet verification safety stop: ${label} returned invalid JSON`);
  }
};

const isRetryableSheetsReadError = (error) => {
  const message = String(error?.message || error);
  return /Sheets API read (?:timed out|request failed|returned HTTP (?:429|5\d\d))$/.test(message);
};

const requestSheetsJson = async ({ fetchImpl, url, options, auth }) => {
  const attempts = Number.isInteger(auth?.sheetsReadAttempts) && auth.sheetsReadAttempts > 0
    ? auth.sheetsReadAttempts
    : 3;
  const retryDelayMs = Number.isInteger(auth?.sheetsReadRetryDelayMs) && auth.sheetsReadRetryDelayMs >= 0
    ? auth.sheetsReadRetryDelayMs
    : 10_000;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson({
        fetchImpl,
        url,
        options,
        timeoutMs: auth.requestTimeoutMs ?? 20_000,
        label: "Sheets API read"
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableSheetsReadError(error) || attempt === attempts) throw error;
      await delay(retryDelayMs);
    }
  }
  throw lastError;
};

const obtainImpersonatedToken = async ({ fetchImpl, auth }) => {
  if (auth?.mode !== "gce-service-account-impersonation" ||
      !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(auth.targetServiceAccount || "")) {
    throw new Error("Import sheet verification safety stop: invalid keyless authentication configuration");
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
    throw new Error("Import sheet verification safety stop: metadata token response was incomplete");
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
        scope: [sheetsReadonlyScope],
        lifetime: `${auth.tokenLifetimeSeconds ?? 600}s`
      })
    },
    timeoutMs,
    label: "service account impersonation"
  });
  if (!impersonated?.accessToken) {
    throw new Error("Import sheet verification safety stop: impersonated token response was incomplete");
  }
  return impersonated.accessToken;
};

export const importVerificationConfig = (sheet) => ({
  ...defaultVerification,
  ...(sheet?.successVerification || {})
});

export const readSheetDateRange = async ({
  sheet,
  expectedDate,
  auth,
  fetchImpl = globalThis.fetch
}) => {
  if (!sheet?.spreadsheetId || !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate || "") ||
      typeof fetchImpl !== "function") {
    throw new Error("Import sheet verification safety stop: invalid verification inputs");
  }

  const verification = importVerificationConfig(sheet);
  if (!/^[A-Z]+$/.test(verification.column) ||
      !Number.isInteger(verification.startRow) || verification.startRow < 1 ||
      !Number.isInteger(verification.endRow) || verification.endRow < verification.startRow) {
    throw new Error("Import sheet verification safety stop: invalid range configuration");
  }

  const range = `${verification.sheetName}!${verification.column}${verification.startRow}:${verification.column}${verification.endRow}`;
  const expectedCellCount = verification.endRow - verification.startRow + 1;
  const token = await obtainImpersonatedToken({ fetchImpl, auth });
  const query = new URLSearchParams({
    majorDimension: "ROWS",
    valueRenderOption: "FORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING"
  });
  const result = await requestSheetsJson({
    fetchImpl,
    url: `${sheetsApiBaseUrl}/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}?${query}`,
    options: { headers: { Authorization: `Bearer ${token}` } },
    auth
  });

  const rows = Array.isArray(result?.values) ? result.values : [];
  const values = rows.map((row) => String(Array.isArray(row) ? (row[0] ?? "") : "").trim());
  const normalized = values.map((value) => ({ value, date: normalizeDate(value) }));
  const formulaErrors = values.filter((value) => /#N\/A|#REF!|#VALUE!|#ERROR!|#DIV\/0!/.test(value));
  const mismatches = normalized.filter(({ date }) => date !== expectedDate);
  const verified = values.length === expectedCellCount &&
    values.every(Boolean) && formulaErrors.length === 0 && mismatches.length === 0;

  return {
    source: "sheets-api-keyless-impersonation",
    sheetName: verification.sheetName,
    range: `${verification.column}${verification.startRow}:${verification.column}${verification.endRow}`,
    expectedDate,
    expectedCellCount,
    nonEmptyCount: values.filter(Boolean).length,
    formulaErrorCount: formulaErrors.length,
    mismatchCount: mismatches.length,
    mismatchSamples: mismatches.slice(0, 5),
    firstValue: values[0] || null,
    lastValue: values.at(-1) || null,
    verified
  };
};

export const verifyImportSheetReportDate = async ({
  sheet,
  reportDate,
  auth,
  fetchImpl = globalThis.fetch
}) => {
  const verificationResult = await readSheetDateRange({
    sheet,
    expectedDate: reportDate,
    auth,
    fetchImpl
  });

  if (!verificationResult.verified) {
    throw new Error(
      `Import sheet verification safety stop: expected ${reportDate} in ${verificationResult.sheetName}!${verificationResult.range}, ` +
      `nonEmpty=${verificationResult.nonEmptyCount}, mismatches=${verificationResult.mismatchCount}, ` +
      `formulaErrors=${verificationResult.formulaErrorCount}`
    );
  }
  return verificationResult;
};
