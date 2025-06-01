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

function handleApiCall(url, body) {
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
        throw new Error("API request timed out");
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

function handleDownloadAction(downloadUrl, classification, action) {
  if (action === "block") {
    showBlockNotification(
      downloadUrl,
      classification.category,
      classification.riskLevel
    );
    pendingDownloads.delete(downloadUrl);
  } else if (action === "allow") {
    const downloadInfo = pendingDownloads.get(downloadUrl);
    if (downloadInfo) {
      chrome.downloads.download(
        { url: downloadInfo.url, filename: downloadInfo.filename },
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
      pendingDownloads.delete(downloadUrl);
    }
  }
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

  pendingDownloads.set(downloadUrl, {
    filename: downloadItem.filename,
    url: downloadUrl,
  });

  handleApiCall(apiUrl, { ApiVersion: "v1", Url: downloadUrl })
    .then((classification) => {
      const action = isDownloadBlocked(classification) ? "block" : "allow";
      handleDownloadAction(downloadUrl, classification, action);
    })
    .catch((error) => {
      console.error(`Error processing download for ${downloadUrl}:`, error);
      const pendingInfo = pendingDownloads.get(downloadUrl);
      if (pendingInfo) {
        const action = CONFIG.DEFAULT_BLOCK_ON_ERROR ? "block" : "allow";
        handleDownloadAction(
          downloadUrl,
          {
            category: "Processing Error",
            riskLevel: CONFIG.MAX_ALLOWED_RISK_LEVEL + 1,
          },
          action
        );
      } else {
        console.warn(
          `Could not find pending download info for ${downloadUrl} during error handling.`
        );
      }
    });

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

        const downloadUrl = downloadItem.url;
        const apiUrl = getApiUrl(CONFIG.TENANT_ID);

        handleApiCall(apiUrl, { ApiVersion: "v1", Url: downloadUrl })
          .then((classification) => {
            const action = isDownloadBlocked(classification)
              ? "block"
              : "allow";
            if (action === "block") {
              chrome.downloads.cancel(downloadItem.id, () => {
                console.log(
                  `Download ${downloadItem.id} cancelled due to policy restrictions.`
                );
              });
              handleDownloadAction(
                downloadUrl,
                {
                  category: "Verification Error",
                  riskLevel: CONFIG.MAX_ALLOWED_RISK_LEVEL + 1,
                },
                "block"
              );
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
            chrome.downloads.cancel(downloadItem.id, () => {
              console.log(
                `Download ${downloadItem.id} cancelled due to verification error.`
              );
            });
            handleDownloadAction(
              downloadUrl,
              {
                category: "Verification Error",
                riskLevel: CONFIG.MAX_ALLOWED_RISK_LEVEL + 1,
              },
              "block"
            );
          });
      }
    });
  }
}

// Intercept downloads before they start
chrome.downloads.onDeterminingFilename.addListener(handleDeterminingFilename);

// Also monitor downloads that might be created by other means (e.g save as, etc.)
chrome.downloads.onCreated.addListener(handleDownloadCreated);
