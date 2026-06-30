"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

function detectLanguage(file: string): string {
  if (/\.blade\.php$/i.test(file)) return "php";
  if (/\.php$/i.test(file)) return "php";
  if (/\.(js|cjs|mjs)$/i.test(file)) return "javascript";
  if (/\.(ts|tsx)$/i.test(file)) return "typescript";
  if (/\.json$/i.test(file)) return "json";
  if (/\.(yml|yaml)$/i.test(file)) return "yaml";
  return "php";
}

export default function CodeViewerPage() {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState("");
  const [line, setLine] = useState(1);
  const [ready, setReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setFile(params.get("file") ?? "");
    setLine(Number(params.get("line") ?? "1") || 1);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!file) {
      setError("No file was provided.");
      return;
    }

    let cancelled = false;
    window.laralens.readCodeFile(file).then((result) => {
      if (cancelled) return;
      if (result.ok && typeof result.content === "string") {
        setError(null);
        setContent(result.content);
        requestAnimationFrame(() => {
          if (cancelled) return;
          document
            .querySelector(`[data-line-number="${line}"]`)
            ?.scrollIntoView({ block: "center" });
          if (scrollRef.current) scrollRef.current.scrollLeft = 0;
        });
      } else {
        setError(result.error ?? "Unable to read file.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [file, line, ready]);

  const language = useMemo(() => detectLanguage(file), [file]);
  const fileName = useMemo(() => {
    const parts = file.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? file;
  }, [file]);

  return (
    <main className="flex h-screen flex-col bg-[var(--void)] text-[var(--flare)]">
      <header className="border-b border-[var(--chassis)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--etch)]">
            Code
          </span>
          <span className="rounded border border-[var(--chassis)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--etch)]">
            {language}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-sm" title={file}>
          {fileName}
          <span className="ml-2 text-[var(--etch)]">{file}</span>
        </div>
      </header>

      {error ? (
        <div className="p-4 text-sm text-red-300">{error}</div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <SyntaxHighlighter
            language={language}
            style={vscDarkPlus}
            showLineNumbers
            wrapLongLines={false}
            customStyle={{
              minHeight: "100%",
              margin: 0,
              padding: "16px 0",
              background: "var(--void)",
              fontSize: "12px",
              lineHeight: "20px",
            }}
            codeTagProps={{
              style: {
                fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Consolas, monospace",
              },
            }}
            lineNumberStyle={{
              minWidth: "44px",
              paddingRight: "16px",
              color: "var(--etch)",
              opacity: 0.75,
              textAlign: "right",
              userSelect: "none",
            }}
            lineProps={(lineNumber) => ({
              "data-line-number": lineNumber,
              style: {
                display: "block",
                paddingRight: "16px",
                paddingLeft: lineNumber === line ? "8px" : "0",
                borderLeft:
                  lineNumber === line ? "3px solid var(--aperture)" : "3px solid transparent",
                background:
                  lineNumber === line ? "rgba(180, 128, 34, 0.32)" : "transparent",
              },
            })}
          >
            {content || " "}
          </SyntaxHighlighter>
        </div>
      )}
    </main>
  );
}
