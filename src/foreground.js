console.log("Foreground script loaded");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "blockPage") {
    document.body.style.backgroundColor = "red";
    console.log(
      "Page background changed to red due to blocked download attempt."
    );
  }
  return true;
});
