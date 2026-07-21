import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../components/MarkdownContent";

describe("MarkdownContent", () => {
  it("renders common and GFM chat Markdown semantically", () => {
    render(<MarkdownContent content={[
      "# Resume plan",
      "Use **two** files and `npm test`.",
      "- First item",
      "- Second item",
      "",
      "| State | Result |",
      "| --- | --- |",
      "| Tests | Passed |"
    ].join("\n")} />);

    expect(screen.getByRole("heading", { name: "Resume plan" })).toBeInTheDocument();
    expect(screen.getByText("two").tagName).toBe("STRONG");
    expect(screen.getByText("npm test").tagName).toBe("CODE");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("blocks raw HTML, active content, and remote image loading", () => {
    const { container } = render(<MarkdownContent content={[
      "<script>alert('unsafe')</script>",
      "[unsafe](javascript:alert(1))",
      "[safe](https://example.com)",
      "![tracker](https://example.com/pixel.png)"
    ].join("\n\n")} />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("unsafe").closest("a")).toBeNull();
    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByText("[Image: tracker]")).toBeInTheDocument();
  });
});
