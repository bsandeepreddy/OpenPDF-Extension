const EXT_ID = chrome.runtime.id;

chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1, 2], // Clear any old buggy rules
  addRules: [
    // Rule 1: The Dynamic Interceptor
    {
      id: 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          // \0 represents the exact PDF URL you clicked
          regexSubstitution: `chrome-extension://${EXT_ID}/viewer.html?file=\\0`
        }
      },
      condition: {
        // Only trigger on URLs that specifically end in .pdf
        regexFilter: "^https?://.*\\.pdf$",
        resourceTypes: ["main_frame"]
      }
    },
    // Rule 2: The Security Bypass (CORS)
    {
      id: 2,
      priority: 2,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "access-control-allow-origin", operation: "set", value: "*" },
          { header: "content-security-policy", operation: "remove" },
          { header: "x-frame-options", operation: "remove" }
        ]
      },
      condition: {
        urlFilter: "|https://*.pdf*",
        resourceTypes: ["xmlhttprequest", "main_frame", "sub_frame"]
      }
    }
  ]
});

// The Data Fetcher for Split/Merge
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_PDF_BINARY") {
        fetch(msg.url)
            .then(res => res.arrayBuffer())
            .then(buffer => sendResponse({ binary: Array.from(new Uint8Array(buffer)) }))
            .catch(err => sendResponse({ error: err.message }));
        return true; 
    }
});