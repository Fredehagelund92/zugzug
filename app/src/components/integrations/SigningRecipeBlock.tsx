import { useEffect, useState } from "react";
import { codeToHtml, type BundledLanguage } from "shiki";
import { Button } from "../Button";

interface Props {
  code: string;
  lang: BundledLanguage;
  filename: string;
}

export function SigningRecipeBlock({ code, lang, filename }: Props) {
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark-dimmed" },
      defaultColor: false,
      cssVariablePrefix: "--shiki-",
    }).then((out) => {
      if (!cancelled) setHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className="relative rounded-sm border border-line bg-surface-2 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-3">
          {filename}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {html ? (
        <div
          className="shiki-host text-[12px] leading-relaxed font-mono overflow-x-auto [&_pre]:!bg-transparent [&_pre]:p-3 [&_pre]:m-0"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-ink whitespace-pre">
          {code}
        </pre>
      )}
    </div>
  );
}
