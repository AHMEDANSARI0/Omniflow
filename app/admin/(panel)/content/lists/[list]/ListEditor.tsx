"use client";

import { useActionState, useId, useRef, useState } from "react";
import { saveMarketingList, type ListActionState } from "../actions";
import { getPath, ICON_OPTIONS, setPath } from "../../../../../../lib/marketing/fields";
import { MARKETING_LISTS, type ListSpec, type MarketingListKey } from "../../../../../../lib/marketing/lists";
import { FieldInput, labelClass, SaveBar } from "../../editor-ui";

const initialState: ListActionState = { success: false, message: "" };

const smallButton =
  "rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:border-brand/30 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40";

type Row = { uid: number; data: object };

function isBlank(value: unknown) {
  return Array.isArray(value) ? !value.some((line) => String(line).trim()) : !String(value ?? "").trim();
}

function emptyItem(spec: ListSpec): object {
  return spec.fields.reduce<object>((item, field) => {
    const value =
      field.type === "lines"
        ? []
        : field.type === "toggle"
          ? false
          : field.type === "select" || (field.type === "icon" && field.required)
            ? ((field.type === "icon" ? ICON_OPTIONS : (field.options ?? []))[0]?.value ?? "")
            : field.type === "color"
              ? "#635BFF"
              : "";
    return setPath(item, field.key, value);
  }, {});
}

/**
 * Schema-driven editor for one marketing list: edit every field, add,
 * remove and reorder items. The whole list is posted as JSON and
 * re-validated on the server with the same schema the website reads.
 */
export default function ListEditor({ listKey, items }: { listKey: MarketingListKey; items: readonly object[] }) {
  const spec: ListSpec = MARKETING_LISTS[listKey];
  const [state, formAction, pending] = useActionState(saveMarketingList, initialState);
  // Row uids: indexes first (identical in server HTML and on the client),
  // then a per-editor counter for added/reloaded rows.
  const idPrefix = useId();
  const nextUid = useRef(items.length);
  const [rows, setRows] = useState<Row[]>(() => items.map((data, uid) => ({ uid, data })));
  const [source, setSource] = useState(items);
  const [openUid, setOpenUid] = useState<number | null>(null);

  // After a save the page re-renders with the stored (clean) list.
  if (source !== items) {
    setSource(items);
    setRows(items.map((data) => ({ uid: nextUid.current++, data })));
  }

  const update = (uid: number, key: string, value: unknown) =>
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, data: setPath(row.data, key, value) } : row)));
  const move = (index: number, delta: number) =>
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      next.splice(index + delta, 0, row);
      return next;
    });
  const remove = (uid: number) => setRows((current) => current.filter((row) => row.uid !== uid));
  const add = () => {
    const row = { uid: nextUid.current++, data: emptyItem(spec) };
    setRows((current) => [...current, row]);
    setOpenUid(row.uid);
  };

  const incomplete = (row: Row) => spec.fields.some((field) => field.required && isBlank(getPath(row.data, field.key)));
  const incompleteCount = rows.filter(incomplete).length;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="list" value={listKey} />
      <input type="hidden" name="items" value={JSON.stringify(rows.map((row) => row.data))} />

      <ol className="space-y-3">
        {rows.map((row, index) => {
          const title = String(getPath(row.data, spec.titleKey) ?? "").trim() || `Untitled ${spec.itemLabel}`;
          const missing = incomplete(row);
          return (
            <li key={row.uid}>
              <details open={row.uid === openUid} className="group rounded-2xl border border-line bg-white shadow-card">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</span>
                  {missing ? (
                    <span className="rounded-md border border-danger/30 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                      Incomplete
                    </span>
                  ) : null}
                  <span className="text-xs text-ink-3 transition-transform group-open:rotate-90">›</span>
                </summary>

                <div className="border-t border-line px-5 pb-5 pt-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {spec.fields.map((field) => {
                      const id = `${idPrefix}-${row.uid}-${field.key}`;
                      const wide = field.type === "textarea" || field.type === "lines";
                      return (
                        <div key={field.key} className={wide ? "sm:col-span-2" : undefined}>
                          <label htmlFor={id} className={labelClass}>
                            {field.label}
                            {field.required ? <span className="text-danger"> *</span> : null}
                          </label>
                          <FieldInput
                            field={field}
                            id={id}
                            value={getPath(row.data, field.key)}
                            onChange={(value) => update(row.uid, field.key, value)}
                          />
                          {field.hint ? <p className="mt-1 text-[11px] text-ink-3">{field.hint}</p> : null}
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" className={smallButton} disabled={index === 0} onClick={() => move(index, -1)}>
                      Move up
                    </button>
                    <button
                      type="button"
                      className={smallButton}
                      disabled={index === rows.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      Move down
                    </button>
                    {!spec.fixed ? (
                      <button
                        type="button"
                        className={`${smallButton} ml-auto hover:border-danger/40 hover:text-danger`}
                        disabled={rows.length <= 1}
                        onClick={() => remove(row.uid)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      {!spec.fixed ? (
        <button
          type="button"
          onClick={add}
          disabled={rows.length >= spec.maxItems}
          className="w-full rounded-2xl border border-dashed border-line bg-white px-4 py-3 text-sm font-medium text-ink-2 transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          + Add {spec.itemLabel} ({rows.length}/{spec.maxItems})
        </button>
      ) : (
        <p className="text-xs text-ink-3">
          The layout needs exactly {spec.maxItems} {spec.itemLabel}s, so they can be edited and reordered but not added or removed.
        </p>
      )}

      {incompleteCount > 0 ? (
        <p className="text-xs text-danger">
          {incompleteCount} {spec.itemLabel}
          {incompleteCount === 1 ? " is" : "s are"} missing required fields{spec.fixed ? "." : " and will be skipped on save."}
        </p>
      ) : null}

      <SaveBar
        pending={pending}
        message={state.message}
        success={state.success}
        resetPrompt="Reset this list to the built-in defaults? Your saved version will be replaced."
      />
    </form>
  );
}
