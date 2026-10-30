(function (global) {
  function parseMetric(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (!value) {
      return null;
    }

    const raw = String(value).replace(/,/g, "").trim();
    const match = raw.match(/(\d+(?:\.\d+)?)(\s*[万wWkK])?/);
    if (!match) {
      return null;
    }

    const number = Number(match[1]);
    if (!Number.isFinite(number)) {
      return null;
    }

    const unit = (match[2] || "").trim();
    if (unit === "万" || unit.toLowerCase() === "w") {
      return Math.round(number * 10000);
    }
    if (unit.toLowerCase() === "k") {
      return Math.round(number * 1000);
    }
    return Math.round(number);
  }

  global.XhhNumber = {
    parseMetric
  };
})(self);
