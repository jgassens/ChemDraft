(() => {
  const downloadLink = document.querySelector("#download-link");
  const releaseMeta = document.querySelector("#release-meta");

  if (!(downloadLink instanceof HTMLAnchorElement) || !(releaseMeta instanceof HTMLElement)) {
    return;
  }

  const formatFileSize = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "";
    }

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  };

  const formatPublishedDate = (publishedAt) => {
    const date = new Date(publishedAt);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  };

  fetch("https://api.github.com/repos/jgassens/ChemDraft/releases/latest")
    .then((response) => {
      if (!response.ok) {
        throw new Error("Latest release unavailable");
      }
      return response.json();
    })
    .then((release) => {
      const asset = release.assets?.find(({ name }) => typeof name === "string" && name.endsWith(".dmg"));
      if (!asset?.browser_download_url) {
        return;
      }

      downloadLink.href = asset.browser_download_url;
      const details = [release.tag_name || release.name, formatPublishedDate(release.published_at), formatFileSize(asset.size)].filter(Boolean);
      if (details.length > 0) {
        releaseMeta.textContent = details.join(" · ");
        releaseMeta.hidden = false;
      }
    })
    .catch(() => {
      // Keep the no-JavaScript release-page fallback intact.
    });
})();
