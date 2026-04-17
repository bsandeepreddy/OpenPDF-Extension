document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.sync.get({ autoIntercept: true }, (items) => {
        document.getElementById('auto-intercept').checked = items.autoIntercept;
    });
});
document.getElementById('auto-intercept').onchange = (e) => {
    chrome.storage.sync.set({ autoIntercept: e.target.checked });
};