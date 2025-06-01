const CONFIG = {
  TENANT_ID: "itiel's tenant",
  API_BASE_URL: "http://localhost:5000/v1/api/urlFiltering",
  BLOCKED_CATEGORIES: ["Social Networking"],
  MAX_ALLOWED_RISK_LEVEL: 1,
  DEFAULT_BLOCK_ON_ERROR: true,
  API_TIMEOUT_MS: 5000,
};

function getApiUrl(tenantId) {
  return `${CONFIG.API_BASE_URL}?x-tenant-id=${encodeURIComponent(tenantId)}`;
}

// Store pending downloads
const pendingDownloads = new Map();

function fetchUrlClassification(downloadUrl, apiUrl) {
  console.log(`Fetching URL classification for: ${downloadUrl}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

  return fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ApiVersion: "v1",
      Url: downloadUrl,
    }),
    signal: controller.signal, // Pass the abort signal to fetch
  })
    .then((response) => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      if (!data.urlClassification) {
        throw new Error(
          "Invalid response structure from API: urlClassification missing"
        );
      }
      return data.urlClassification;
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        console.error(
          `Fetch timed out for ${downloadUrl} after ${CONFIG.API_TIMEOUT_MS}ms`
        );
        throw new Error(`API request timed out for ${downloadUrl}`);
      }
      throw error;
    });
}

function isDownloadBlocked(classification) {
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

function handleAllowedDeterminedDownload(downloadUrl, classification) {
  console.log(
    `Allowing download (onDeterminingFilename) from ${downloadUrl}. Category: ${classification.category}, Risk: ${classification.riskLevel}`
  );
  // If allowed, start the download manually
  const downloadInfo = pendingDownloads.get(downloadUrl);
  if (downloadInfo) {
    chrome.downloads.download(
      {
        url: downloadInfo.url,
        filename: downloadInfo.filename,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(
            `Failed to start download: ${chrome.runtime.lastError.message}`
          );
        } else {
          console.log(`Download started with ID: ${downloadId}`);
        }
        pendingDownloads.delete(downloadUrl);
      }
    );
  } else {
    console.warn(`Could not find pending download info for ${downloadUrl}`);
    pendingDownloads.delete(downloadUrl); // Clean up if info is missing
  }
}

function handleBlockedDownload(downloadUrl, classification) {
  showBlockNotification(
    downloadUrl,
    classification.category,
    classification.riskLevel
  );
  pendingDownloads.delete(downloadUrl);
}

function handleDeterminingFilename(downloadItem, suggest) {
  if (!downloadItem.url) {
    console.log("Download has no URL, allowing it to proceed.");
    suggest();
    return false;
  }

  const downloadUrl = downloadItem.url;
  const apiUrl = getApiUrl(CONFIG.TENANT_ID);

  console.log(
    `onDeterminingFilename: Intercepting download. URL: ${downloadUrl}`
  );

  // Store download information for later use
  pendingDownloads.set(downloadUrl, {
    filename: downloadItem.filename,
    url: downloadUrl,
  });

  fetchUrlClassification(downloadUrl, apiUrl)
    .then((classification) => {
      if (isDownloadBlocked(classification)) {
        console.log(`Download blocked: ${downloadUrl}`);
        handleBlockedDownload(downloadUrl, classification);
      } else {
        console.log(`Download allowed: ${downloadUrl}`);
        handleAllowedDeterminedDownload(downloadUrl, classification);
      }
    })
    .catch((error) => {
      console.error(
        `onDeterminingFilename: Error processing download for ${downloadUrl}:`,
        error
      );
      const pendingInfo = pendingDownloads.get(downloadUrl);
      if (pendingInfo) {
        if (CONFIG.DEFAULT_BLOCK_ON_ERROR) {
          console.warn(
            `Blocking download for ${downloadUrl} due to error (DEFAULT_BLOCK_ON_ERROR is true). Error: ${error.message}`
          );
          handleBlockedDownload(downloadUrl, {
            category: "Processing Error",
            riskLevel: CONFIG.MAX_ALLOWED_RISK_LEVEL + 1, // Treat as high risk to ensure block
          });
        } else {
          console.warn(
            `Allowing download for ${downloadUrl} despite error (DEFAULT_BLOCK_ON_ERROR is false), using original filename. Error: ${error.message}`
          );
          handleAllowedDeterminedDownload(downloadUrl, {
            category: "Unknown",
            riskLevel: CONFIG.MAX_ALLOWED_RISK_LEVEL, // Default risk level
          });
        }
      } else {
        console.warn(
          `onDeterminingFilename: Could not find pending download info for ${downloadUrl} during error handling.`
        );
      }
    });

  return true; // Indicate we are handling the download asynchronously
}

function handleDownloadCreated(downloadItem) {
  if (downloadItem.url) {
    console.log(
      `onCreated: Detected download not initiated by our extension. URL: ${downloadItem.url}`
    );

    // Pause the download immediately
    chrome.downloads.pause(downloadItem.id, () => {
      if (chrome.runtime.lastError) {
        console.error(
          `Failed to pause download ${downloadItem.id}: ${chrome.runtime.lastError.message}`
        );
      } else {
        console.log(`Download ${downloadItem.id} paused for checking.`);

        const downloadUrl = downloadItem.url;
        const apiUrl = getApiUrl(CONFIG.TENANT_ID);

        fetchUrlClassification(downloadUrl, apiUrl)
          .then((classification) => {
            if (isDownloadBlocked(classification)) {
              console.log(`Download blocked: ${downloadUrl}`);
              chrome.downloads.cancel(downloadItem.id, () => {
                console.log(
                  `Download ${downloadItem.id} cancelled due to policy restrictions.`
                );
              });
            } else {
              console.log(`Download allowed: ${downloadUrl}`);
              chrome.downloads.resume(downloadItem.id, () => {
                console.log(
                  `Download ${downloadItem.id} resumed after verification.`
                );
              });
            }
          })
          .catch((error) => {
            console.error("Error verifying download URL:", error);
            chrome.downloads.cancel(downloadItem.id, () => {
              console.log(
                `Download ${downloadItem.id} cancelled due to verification error.`
              );
            });
          });
      }
    });
  }
}

// Intercept downloads before they start
chrome.downloads.onDeterminingFilename.addListener(handleDeterminingFilename);

// Also monitor downloads that might be created by other means (e.g save as, etc.)
chrome.downloads.onCreated.addListener(handleDownloadCreated);
