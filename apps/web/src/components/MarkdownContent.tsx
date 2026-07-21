import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

function safeUrlTransform(url: string): string {
  if (url.startsWith("#")) return url;
  try {
    const parsed = new URL(url);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) return url;
  } catch {
    return "";
  }
  return "";
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={["markdown-content", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrlTransform}
        components={{
          a: ({ children, href, ...props }) => href ? (
            <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          ) : <span>{children}</span>,
          img: ({ alt }) => <span className="markdown-image-omitted">{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
