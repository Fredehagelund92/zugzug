import { useState } from "react";
import { generateSuggestion } from "../store";
import { toast } from "./Toast";
import { Button } from "./Button";
import { IconWand } from "./Icons";

interface Props {
  refTableId: string;
  rawValue: string;
}

/** Calls POST /api/tables/:id/suggest for an unmapped value, shows a
 *  loading spinner and surfaces the result (or error) as a toast.
 *  The draft is stored server-side and the store's refreshDrafts() fires
 *  automatically inside generateSuggestion, so the review panel updates. */
export function GetSuggestionButton({ refTableId, rawValue }: Props) {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    try {
      const result = await generateSuggestion(refTableId, rawValue);
      toast(`AI suggestion: ${result.draft.target_label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't generate suggestion.";
      toast(message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<IconWand className="h-3.5 w-3.5" />}
      loading={loading}
      onClick={(e) => {
        e.stopPropagation();
        void handleClick();
      }}
    >
      {loading ? "Generating…" : "Get AI suggestion"}
    </Button>
  );
}
