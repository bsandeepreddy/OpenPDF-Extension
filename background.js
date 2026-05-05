// ============================================================
// OpenPDF — background.js (v2.0 — Chrome Web Store Safe)
//
// CORS FIX:
//   Old Rule 2 stripped content-security-policy globally —
//   Chrome Web Store rejects this as a broad security bypass.
//
//   New Rule 2 uses initiatorDomains so it ONLY fires when
//   our own extension viewer page makes a fetch() request.
//   No other website is affected. This passes Web Store review.
// ============================================================

const EXT_ID = chrome.runtime.id;

chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1, 2],
  addRules: [

    // Rule 1: Redirect .pdf navigation to our viewer
    {
      id: 1,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: {
          regexSubstitution:
            `chrome-extension://${EXT_ID}/viewer.html?file=\\0`
        }
      },
      condition: {
        regexFilter: '^https?://.*\\.pdf(\\?.*)?$',
        resourceTypes: ['main_frame']
      }
    },

    // Rule 2: CORS — scoped ONLY to our extension's own requests
    // initiatorDomains = only fires when our viewer.html fetches
    // No global CSP stripping — that was the Web Store red flag
    {
      id: 2,
      priority: 2,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          {
            header: 'access-control-allow-origin',
            operation: 'set',
            value: `chrome-extension://${EXT_ID}`
          },
          {
            header: 'x-frame-options',
            operation: 'remove'
          }
        ]
      },
      condition: {
        regexFilter: '^https?://.*\\.pdf(\\?.*)?$',
        initiatorDomains: [`${EXT_ID}.chromiumapp.org`],
        resourceTypes: ['xmlhttprequest']
      }
    }
  ]
});
