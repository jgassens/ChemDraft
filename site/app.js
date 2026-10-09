(() => {
  const targets = [
    {
      link: document.querySelector("#download-mac"),
      meta: document.querySelector("#release-meta-mac"),
      find: (assets) => assets.find(({ name }) => typeof name === "string" && name.endsWith(".dmg")),
    },
    {
      link: document.querySelector("#download-windows"),
      meta: document.querySelector("#release-meta-windows"),
      find: (assets) => {
        const setups = assets.filter(({ name }) => typeof name === "string" && name.endsWith("-setup.exe"));
        return setups.find(({ name }) => name.includes("x64")) || setups[0];
      },
    },
  ].filter(({ link, meta }) => link instanceof HTMLAnchorElement && meta instanceof HTMLElement);

  if (targets.length === 0) {
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
      const assets = Array.isArray(release.assets) ? release.assets : [];
      for (const { link, meta, find } of targets) {
        const asset = find(assets);
        if (!asset?.browser_download_url) {
          continue;
        }

        link.href = asset.browser_download_url;
        const details = [release.tag_name || release.name, formatPublishedDate(release.published_at), formatFileSize(asset.size)].filter(Boolean);
        if (details.length > 0) {
          meta.textContent = details.join(" · ");
          meta.hidden = false;
        }
      }
    })
    .catch(() => {
      // Keep the no-JavaScript release-page fallback intact.
    });
})();
