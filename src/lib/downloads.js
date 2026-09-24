// Download capture via chrome.downloads. The agent can wait for a download
// triggered by a click and report where it landed, or save arbitrary content
// (screenshots, PDFs, page data) to the downloads folder.

export class DownloadManager {
  constructor() {
    this.created = []; // ids created since the manager was constructed
    this._onCreated = (item) => {
      this.created.push(item.id);
    };
    chrome.downloads.onCreated.addListener(this._onCreated);
  }

  dispose() {
    chrome.downloads.onCreated.removeListener(this._onCreated);
    this.created = [];
  }

  async waitForDownload({ urlPart = "", timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 20000, 1000), 120000);
    const startIndex = this.created.length;
    while (Date.now() < deadline) {
      const pending = this.created.slice(startIndex);
      for (const id of pending) {
        const [item] = await chrome.downloads.search({ id });
        if (!item) continue;
        if (urlPart && !String(item.url || "").includes(urlPart) && !String(item.filename || "").includes(urlPart)) {
          continue;
        }
        if (item.state === "complete") {
          return { ok: true, filename: item.filename, url: item.url, mime: item.mime, bytes: item.totalBytes };
        }
        if (item.state === "interrupted") {
          return { ok: false, error: `Download interrupted (${item.error || "unknown"}).` };
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, error: "Timed out waiting for a download." };
  }

  async saveUrl(url, filename) {
    const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    return await this._waitId(id);
  }

  async saveDataUrl(dataUrl, filename) {
    const id = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false, conflictAction: "uniquify" });
    return await this._waitId(id);
  }

  async _waitId(id) {
    if (id == null) return { ok: false, error: "Download could not be started." };
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state === "complete") return { ok: true, filename: item.filename, bytes: item.totalBytes };
      if (item && item.state === "interrupted") return { ok: false, error: item.error || "interrupted" };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: false, error: "Timed out saving download." };
  }
}
