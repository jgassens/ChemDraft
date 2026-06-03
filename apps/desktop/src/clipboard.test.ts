import { describe, expect, it } from "vitest";
import { clipboardPayloadFromDataTransfer } from "./clipboard";

describe("desktop clipboard bridge", () => {
  it("extracts text items from paste event clipboard data", () => {
    const payload = clipboardPayloadFromDataTransfer({
      types: ["text/html", "text/plain", "public.svg-image"],
      getData: (type: string) => {
        if (type === "text/plain") {
          return "pasted text";
        }

        if (type === "public.svg-image") {
          return "<svg />";
        }

        return "";
      }
    } as unknown as DataTransfer);

    expect(payload).toEqual({
      types: ["text/html", "text/plain", "public.svg-image"],
      textItems: [
        { type: "text/plain", text: "pasted text" },
        { type: "public.svg-image", text: "<svg />" }
      ]
    });
  });
});
