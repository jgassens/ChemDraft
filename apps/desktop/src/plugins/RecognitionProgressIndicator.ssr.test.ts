import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RecognitionInstallProgress } from "./RecognitionInstallProgress";
import { RecognitionProgressIndicator, type RecognitionActivitySource } from "./RecognitionProgressIndicator";

const idleSource: RecognitionActivitySource = {
  getActiveRecognition: () => undefined,
  subscribeActivity: () => () => {}
};

describe("recognition progress components under server rendering", () => {
  it("server-renders RecognitionProgressIndicator without throwing", () => {
    expect(() =>
      renderToStaticMarkup(createElement(RecognitionProgressIndicator, { source: idleSource, onCancel: () => {} }))
    ).not.toThrow();
  });

  it("server-renders RecognitionInstallProgress without throwing", () => {
    expect(() => renderToStaticMarkup(createElement(RecognitionInstallProgress, {}))).not.toThrow();
  });
});
