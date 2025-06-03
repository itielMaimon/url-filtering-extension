const CONFIG = {
  TENANT_ID: "itiel's tenant",
  API_BASE_URL: "http://localhost:5000/v1/api/urlFiltering",
  BLOCKED_CATEGORIES: ["Social Networking"],
  MAX_ALLOWED_RISK_LEVEL: 1,
  DEFAULT_BLOCK_ON_ERROR: true,
  API_TIMEOUT_MS: 5000,
};

const DEFAULT_CLASSIFICATION = {
  category: "Unknown",
  riskLevel: CONFIG.MAX_ALLOWED_RISK_LEVEL + 1,
};

function getApiUrl(tenantId) {
  return `${CONFIG.API_BASE_URL}?x-tenant-id=${encodeURIComponent(tenantId)}`;
}

function handleApiCallWithRetry(url, body, retries = 3, delay = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then((response) => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        console.error(`Fetch timed out after ${CONFIG.API_TIMEOUT_MS}ms`);
      }
      if (retries > 0) {
        console.warn(`Retrying API call. Remaining retries: ${retries - 1}`);
        return new Promise((resolve) => setTimeout(resolve, delay)).then(() =>
          handleApiCallWithRetry(url, body, retries - 1, delay * 2)
        );
      }
      throw error;
    });
}

function isDownloadBlocked(classification) {
  console.log(
    `Checking if download is blocked: Category '${classification.category}', Risk Level ${classification.riskLevel}`
  );
  const { category, riskLevel } = classification;
  return (
    CONFIG.BLOCKED_CATEGORIES.includes(category) ||
    riskLevel > CONFIG.MAX_ALLOWED_RISK_LEVEL
  );
}

function showBlockNotification(downloadUrl, category, riskLevel) {
  console.log(
    `Blocking download from ${downloadUrl}: Category '${category}', Risk Level ${riskLevel}`
  );
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs.length > 0 && tabs[0].id) {
      chrome.tabs
        .sendMessage(tabs[0].id, { action: "blockPage" })
        ?.catch((error) =>
          console.warn(
            `Could not send blockPage message to tab ${tabs[0].id}: ${error.message}`
          )
        );
    }
  });
}

function handleDownloadAction(downloadItem, classification, action, suggest) {
  if (action === "block") {
    suggest?.({}); // Cancel the download
    showBlockNotification(
      downloadItem.url,
      classification.category,
      classification.riskLevel
    );
  } else if (action === "allow") {
    suggest?.({ filename: downloadItem.filename });
  }
}

function processDownload(downloadItem, apiUrl, suggest) {
  handleApiCallWithRetry(apiUrl, {
    ApiVersion: "v1",
    Url: downloadItem.url,
  })
    .then((data) => {
      const classification = data.urlClassification;
      const action = isDownloadBlocked(classification) ? "block" : "allow";
      handleDownloadAction(downloadItem, classification, action, suggest);
    })
    .catch((error) => {
      console.error(
        `Error processing download for ${downloadItem.url}:`,
        error
      );
      const action = CONFIG.DEFAULT_BLOCK_ON_ERROR ? "block" : "allow";
      handleDownloadAction(
        downloadItem,
        DEFAULT_CLASSIFICATION,
        action,
        suggest
      );
    });
}

function handleDeterminingFilename(downloadItem, suggest) {
  if (!downloadItem.url) {
    console.log("Download has no URL, allowing it to proceed.");
    suggest();
    return false;
  }

  const apiUrl = getApiUrl(CONFIG.TENANT_ID);

  console.log(
    `onDeterminingFilename: Intercepting download. URL: ${downloadItem.url}`
  );

  processDownload(downloadItem, apiUrl, suggest);

  return true;
}

function handleDownloadCreated(downloadItem) {
  if (downloadItem.url) {
    console.log(
      `onCreated: Detected download not initiated by our extension. URL: ${downloadItem.url}`
    );

    chrome.downloads.pause(downloadItem.id, () => {
      if (chrome.runtime.lastError) {
        console.error(
          `Failed to pause download ${downloadItem.id}: ${chrome.runtime.lastError.message}`
        );
      } else {
        console.log(`Download ${downloadItem.id} paused for checking.`);

        const apiUrl = getApiUrl(CONFIG.TENANT_ID);

        handleApiCallWithRetry(apiUrl, {
          ApiVersion: "v1",
          Url: downloadItem.url,
        })
          .then((data) => {
            const classification = data.urlClassification;
            const action = isDownloadBlocked(classification)
              ? "block"
              : "allow";
            if (action === "block") {
              chrome.downloads.cancel(downloadItem.id, () => {
                console.log(
                  `Download ${downloadItem.id} cancelled due to policy restrictions.`
                );
              });
              handleDownloadAction(downloadItem, classification, "block");
            } else {
              chrome.downloads.resume(downloadItem.id, () => {
                console.log(
                  `Download ${downloadItem.id} resumed after verification.`
                );
              });
            }
          })
          .catch((error) => {
            console.error("Error verifying download URL:", error);
            if (CONFIG.DEFAULT_BLOCK_ON_ERROR) {
              chrome.downloads.cancel(downloadItem.id, () => {
                console.log(
                  `Download ${downloadItem.id} cancelled due to verification error.`
                );
              });
            } else {
              chrome.downloads.resume(downloadItem.id, () => {
                console.log(
                  `Download ${downloadItem.id} resumed despite verification error.`
                );
              });
            }
            const action = CONFIG.DEFAULT_BLOCK_ON_ERROR ? "block" : "allow";
            handleDownloadAction(downloadItem, DEFAULT_CLASSIFICATION, action);
          });
      }
    });
  }
}

// Intercept downloads before they start
chrome.downloads.onDeterminingFilename.addListener(handleDeterminingFilename);

// Also monitor downloads that might be created by other means (e.g save as, etc.)
chrome.downloads.onCreated.addListener(handleDownloadCreated);
