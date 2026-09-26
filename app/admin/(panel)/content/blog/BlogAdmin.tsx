"use client";

import { useActionState } from "react";
import {
  deleteBlogPost,
  saveBlogPost,
  type BlogActionState,
} from "./actions";

const initialState: BlogActionState = { success: false, message: "" };

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40";

const labelClass = "mb-1.5 block text-xs font-medium text-ink-3";

export type AdminPost = {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  author: string;
  reading_minutes: number;
  status: string;
  published_at: string | null;
};

export default function BlogAdmin({ posts }: { posts: AdminPost[] }) {
  const [saveState, saveAction, savePending] = useActionState(
    saveBlogPost,
    initialState
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteBlogPost,
    initialState
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      {/* published posts list */}
      <div className="space-y-2.5">
        <p className="text-xs font-medium text-ink-3">
          Posts ({posts.length})
        </p>
        {posts.length === 0 ? (
          <p className="rounded-xl border border-line bg-soft px-3.5 py-3 text-xs text-ink-3">
            No posts yet — write the first one. Until a post is saved, the
            website shows the built-in seed articles.
          </p>
        ) : null}
        {posts.map((post) => (
          <div
            key={post.slug}
            className="rounded-xl border border-line bg-soft p-3.5"
          >
            <p className="text-[13px] font-medium leading-snug text-ink">
              {post.title}
            </p>
            <p className="mt-1 truncate text-[11px] text-ink-3">
              /blog/{post.slug}
            </p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span
                className={
                  post.status === "published"
                    ? "rounded-full bg-ok-soft px-2 py-0.5 text-[10px] font-semibold text-ok"
                    : "rounded-full bg-slate-500/15 px-2 py-0.5 text-[10px] font-semibold text-ink-3"
                }
              >
                {post.status}
              </span>
              <form action={deleteAction}>
                <input type="hidden" name="delete_slug" value={post.slug} />
                <button
                  type="submit"
                  disabled={deletePending}
                  className="text-[11px] font-medium text-danger/80 transition-colors hover:text-danger disabled:opacity-50"
                >
                  Delete
                </button>
              </form>
            </div>
          </div>
        ))}
        {deleteState.message ? (
          <p className="text-xs text-ink-3">{deleteState.message}</p>
        ) : null}
      </div>

      {/* editor */}
      <form
        action={saveAction}
        className="space-y-6 rounded-2xl border border-line bg-soft p-6"
      >
        <div>
          <h2 className="text-sm font-semibold text-ink">Write a post</h2>
          <p className="mt-1 text-xs text-ink-3">
            Content supports simple formatting: lines starting with “## ”
            become headings, lines starting with “- ” become bullets. Existing
            slug = edit.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="title" className={labelClass}>
              Title
            </label>
            <input id="title" name="title" className={inputClass} required />
          </div>
          <div>
            <label htmlFor="slug" className={labelClass}>
              Slug (the URL part)
            </label>
            <input
              id="slug"
              name="slug"
              placeholder="whatsapp-automation-101"
              className={inputClass}
              required
            />
          </div>
          <div>
            <label htmlFor="category" className={labelClass}>
              Category
            </label>
            <select id="category" name="category" className={inputClass} defaultValue="AI Automation">
              {[
                "AI Automation",
                "WhatsApp Automation",
                "Customer Support",
                "Sales Automation",
                "Business Operations",
                "AI Agents",
                "Workflows",
              ].map((option) => (
                <option key={option} value={option} className="bg-soft">
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="author" className={labelClass}>
              Author
            </label>
            <input
              id="author"
              name="author"
              defaultValue="OmniFlow Team"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="reading_minutes" className={labelClass}>
              Reading minutes
            </label>
            <input
              id="reading_minutes"
              name="reading_minutes"
              type="number"
              min={1}
              max={60}
              defaultValue={5}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="status" className={labelClass}>
              Status
            </label>
            <select id="status" name="status" className={inputClass} defaultValue="draft">
              <option value="draft" className="bg-soft">
                Draft
              </option>
              <option value="published" className="bg-soft">
                Published
              </option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="published_at" className={labelClass}>
              Publish date (optional — defaults to now when publishing)
            </label>
            <input
              id="published_at"
              name="published_at"
              type="date"
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="excerpt" className={labelClass}>
              Excerpt (shown on cards)
            </label>
            <textarea id="excerpt" name="excerpt" rows={2} className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="content" className={labelClass}>
              Content
            </label>
            <textarea
              id="content"
              name="content"
              rows={14}
              className={inputClass + " font-mono text-[13px]"}
              required
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={savePending}
            className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
          >
            {savePending ? "Saving..." : "Save post"}
          </button>
          {saveState.message ? (
            <span
              className={
                "text-xs " + (saveState.success ? "text-ok" : "text-danger")
              }
            >
              {saveState.message}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
