"use client";

import { useActionState, useId, useMemo, useState } from "react";
import { saveCopyBlock, type CopyActionState } from "../actions";
import { getPath, setPath } from "../../../../../../lib/marketing/fields";
import { COPY_BLOCKS, copyFields, type CopyBlockKey } from "../../../../../../lib/marketing/copy";
import { FieldInput, labelClass, SaveBar } from "../../editor-ui";

const initialState: CopyActionState = { success: false, message: "" };

/**
 * Editor for one copy block. Fields are derived from the block's default
 * shape and grouped by top-level key; each shows its default as the
 * placeholder. The whole object is posted and re-validated on the server.
 */
export default function CopyEditor({ blockKey, value }: { blockKey: CopyBlockKey; value: object }) {
  const defaults = COPY_BLOCKS[blockKey].defaults;
  const groups = useMemo(() => copyFields(defaults), [defaults]);
  const [state, formAction, pending] = useActionState(saveCopyBlock, initialState);
  const idPrefix = useId();
  const [draft, setDraft] = useState<object>(value);
  const [source, setSource] = useState(value);

  // After a save the page re-renders with the stored (clean) copy.
  if (source !== value) {
    setSource(value);
    setDraft(value);
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="block" value={blockKey} />
      <input type="hidden" name="value" value={JSON.stringify(draft)} />

      {groups.map((group, index) => (
        <details key={group.key} open={index === 0} className="group rounded-2xl border border-line bg-white shadow-card">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{group.title}</span>
            <span className="text-[11px] text-ink-3">
              {group.fields.length} field{group.fields.length === 1 ? "" : "s"}
            </span>
            <span className="text-xs text-ink-3 transition-transform group-open:rotate-90">›</span>
          </summary>
          <div className="grid gap-4 border-t border-line px-5 pb-5 pt-4 sm:grid-cols-2">
            {group.fields.map((field) => {
              const id = `${idPrefix}-${field.key}`;
              const wide = field.type === "textarea" || field.type === "lines";
              const fallback = getPath(defaults, field.key);
              return (
                <div
                  key={field.key}
                  className={`${wide ? "sm:col-span-2" : ""} ${field.type === "toggle" ? "flex items-center gap-2" : ""}`}
                >
                  <label htmlFor={id} className={field.type === "toggle" ? "order-2 text-xs font-medium text-ink-3" : labelClass}>
                    {field.label}
                  </label>
                  <FieldInput
                    field={field}
                    id={id}
                    value={getPath(draft, field.key)}
                    placeholder={Array.isArray(fallback) ? fallback.join("\n") : String(fallback ?? "")}
                    onChange={(next) => setDraft((current) => setPath(current, field.key, next))}
                  />
                </div>
              );
            })}
          </div>
        </details>
      ))}

      <SaveBar
        pending={pending}
        message={state.message}
        success={state.success}
        resetPrompt="Reset this copy to the built-in defaults? Your saved version will be replaced."
      />
    </form>
  );
}
