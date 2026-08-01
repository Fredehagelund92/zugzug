import { useState } from "react";
import { Button } from "../../components/Button";

interface Props {
  value: string;
  onClose: () => void;
  title?: string;
}

export function SecretRevealModal({ value, onClose, title = "Copy your signing secret" }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-[460px] max-w-full rounded-sm border border-line bg-surface p-5 space-y-3"
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      >
        <h2 className="font-display text-[15px] font-semibold text-ink">{title}</h2>
        <p className="text-[13px] text-ink-2">This is the only time you&apos;ll see this value.</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-sm bg-surface-2 px-2 py-1.5 font-mono text-[12px] break-all">
            {value}
          </code>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(value);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={onClose}
            disabled={!copied}
            title={copied ? undefined : "Copy the secret first"}
          >
            I&apos;ve copied it
          </Button>
        </div>
      </div>
    </div>
  );
}
