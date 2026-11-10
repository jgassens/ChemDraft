(() => {
  const targets = [
    {
      link: document.querySelector("#download-mac-apple"),
      meta: document.querySelector("#release-meta-mac-apple"),
      find: (assets) => assets.find(({ name }) => typeof name === "string" && /^ChemDraft_.+_aarch64\.dmg$/.test(name)),
    },
    {
      link: document.querySelector("#download-mac-intel"),
      meta: document.querySelector("#release-meta-mac-intel"),
      find: (assets) => assets.find(({ name }) => typeof name === "string" && /^ChemDraft_.+_x86_64\.dmg$/.test(name)),
    },
    {
      link: document.querySelector("#download-windows"),
      meta: document.querySelector("#release-meta-windows"),
      find: (assets) => assets.find(({ name }) => typeof name === "string" && /^ChemDraft_.+_x64-setup\.exe$/.test(name)),
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
          link.closest(".download-option").hidden = true;
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
