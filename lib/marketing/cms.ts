import { cache } from "react";
import { getSectionContent } from "../content";
import { COPY_BLOCKS, sanitizeCopy, type CopyBlockKey, type CopyValue } from "./copy";
import { MARKETING_LISTS, sanitizeList, type MarketingListItem, type MarketingListKey } from "./lists";

/**
 * Server-side readers for the admin-editable marketing content. Both use
 * the same cached, tag-revalidated `site_content` read as every section,
 * and `cache()` so each row is read once per request however many
 * components need it. Missing, empty or invalid data falls back to the
 * code defaults, so a bad row can never break a page.
 */
export const getMarketingList = cache(
  async <K extends MarketingListKey>(key: K): Promise<MarketingListItem[K][]> => {
    const spec = MARKETING_LISTS[key];
    const content = await getSectionContent<{ items: unknown }>(spec.section, { items: null });
    const items = sanitizeList(key, content.items);
    return items.length ? items : (spec.defaults as unknown as MarketingListItem[K][]);
  }
);

export const getCopy = cache(async <K extends CopyBlockKey>(key: K): Promise<CopyValue<K>> => {
  const stored = await getSectionContent<Record<string, unknown>>(COPY_BLOCKS[key].section, {});
  return sanitizeCopy(key, stored);
});
