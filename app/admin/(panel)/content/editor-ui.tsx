"use client";

import { HEX_COLOR, ICON_OPTIONS, type ListField } from "../../../../lib/marketing/fields";

/** Shared inputs for the marketing list and copy editors. */
export const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";
export const labelClass = "mb-1.5 block text-xs font-medium text-ink-3";

export function FieldInput({
  field,
  value,
  id,
  placeholder,
  onChange,
}: {
  field: ListField;
  value: unknown;
  id: string;
  placeholder?: string;
  onChange: (value: unknown) => void;
}) {
  const text = Array.isArray(value) ? value.join("\n") : String(value ?? "");
  switch (field.type) {
    case "textarea":
    case "lines":
      return (
        <textarea
          id={id}
          rows={field.type === "lines" ? 4 : 3}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(field.type === "lines" ? e.target.value.split("\n") : e.target.value)}
          className={`${inputClass} resize-y`}
        />
      );
    case "select":
    case "icon": {
      const options = field.type === "icon" ? ICON_OPTIONS : (field.options ?? []);
      return (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          {!field.required ? <option value="">None</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }
    case "toggle":
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-brand"
        />
      );
    case "number":
      return (
        <input
          id={id}
          type="number"
          min={0}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          className={inputClass}
        />
      );
    case "color":
      return (
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-9 w-9 shrink-0 rounded-lg border border-line"
            style={{ background: HEX_COLOR.test(text) ? text : "transparent" }}
          />
          <input id={id} type="text" value={text} onChange={(e) => onChange(e.target.value)} className={inputClass} />
        </div>
      );
    default:
      return (
        <input
          id={id}
          type="text"
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      );
  }
}

/** Save + "Reset to defaults" (confirmed) + the action's status message. */
export function SaveBar({
  pending,
  message,
  success,
  resetPrompt,
}: {
  pending: boolean;
  message: string;
  success: boolean;
  resetPrompt: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 pt-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl bg-brand px-6 py-2.5 text-sm font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save changes"}
      </button>
      <button
        type="submit"
        name="intent"
        value="reset"
        disabled={pending}
        onClick={(event) => {
          if (!window.confirm(resetPrompt)) event.preventDefault();
        }}
        className="rounded-xl border border-line bg-white px-4 py-2.5 text-sm font-medium text-ink-2 transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-60"
      >
        Reset to defaults
      </button>
      {message ? (
        <p role="status" className={`text-xs ${success ? "text-ok" : "text-danger"}`}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
