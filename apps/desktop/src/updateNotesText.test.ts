import { describe, expect, it } from "vitest";
import { updateNotesPlainText } from "./updateNotesText";

describe("updateNotesPlainText", () => {
  it("normalizes line endings, headings, paragraphs, and list markers", () => {
    expect(updateNotesPlainText("# Changes\r\n\r\n- One\r\n  * Two\r\n+ Three\r\n1. Four\n\n\n\nDone")).toBe(
      "Changes\n\n• One\n  • Two\n• Three\n1. Four\n\nDone"
    );
  });

  it("removes paired emphasis and inline code without changing identifiers or lone markers", () => {
    expect(updateNotesPlainText("**bold** __strong__ *italic* _emphasis_ `code` snake_case_value * lone")).toBe(
      "bold strong italic emphasis code snake_case_value * lone"
    );
  });

  it("writes links as their text followed by their URL", () => {
    expect(updateNotesPlainText("Read [the guide](https://example.com/guide)."))
      .toBe("Read the guide (https://example.com/guide).");
  });

  it("preserves code-span contents and link URLs while formatting link text", () => {
    expect(updateNotesPlainText("`__dirname__`")).toBe("__dirname__");
    expect(updateNotesPlainText("`*.*`")).toBe("*.*");
    expect(updateNotesPlainText("[guide](https://example.com/_draft_/guide)"))
      .toBe("guide (https://example.com/_draft_/guide)");
    expect(updateNotesPlainText("[**bold** guide](url)")).toBe("bold guide (url)");
  });

  it("replaces glyphs unavailable in Windows task-dialog fonts", () => {
    expect(updateNotesPlainText("▸ ▹ ▶ ►")).toBe("› › › ›");
  });

  it("converts the 0.3.8 release notes to task-dialog text", () => {
    const notes = "ChemDraft can now send bug and crash reports straight from the app.\n\n- **Report a Bug.** Help ▸ Report a Bug… opens your own email program with a report already started, including your ChemDraft version and computer type. Nothing is sent until you press Send.\n- **Crash reports.** If ChemDraft runs into an error, or shut down last time because of an internal error, it offers to email a crash report with the details filled in. You can read the email before sending, or say Not Now.\n- **Plain window title.** The released app's window title now reads simply \"ChemDraft\".";

    expect(updateNotesPlainText(notes)).toBe(
      "ChemDraft can now send bug and crash reports straight from the app.\n\n• Report a Bug. Help › Report a Bug… opens your own email program with a report already started, including your ChemDraft version and computer type. Nothing is sent until you press Send.\n• Crash reports. If ChemDraft runs into an error, or shut down last time because of an internal error, it offers to email a crash report with the details filled in. You can read the email before sending, or say Not Now.\n• Plain window title. The released app's window title now reads simply \"ChemDraft\"."
    );
  });
});
