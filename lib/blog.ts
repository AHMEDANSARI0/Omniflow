import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * The OmniFlow blog. Posts live in the `blog_posts` table (managed in
 * Admin > Content > Blog); the three seed articles below double as the
 * code-level fallback, so the blog renders even before the SQL is
 * applied or if the database is unreachable — the same contract as
 * getSectionContent.
 */

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  author: string;
  reading_minutes: number;
  content: string;
  published_at: string | null;
}

export const BLOG_CATEGORIES = [
  "AI Automation",
  "WhatsApp Automation",
  "Customer Support",
  "Sales Automation",
  "Business Operations",
  "AI Agents",
  "Workflows",
] as const;

export const SEED_POSTS: BlogPost[] = [
  {
    slug: "whatsapp-is-your-best-support-channel",
    title: "Why WhatsApp is your best support channel — and how to automate it right",
    excerpt:
      "Your customers already message you on WhatsApp. Here is how to answer faster without losing the personal touch your business is known for.",
    category: "WhatsApp Automation",
    author: "OmniFlow Team",
    reading_minutes: 5,
    published_at: "2026-09-01T09:00:00Z",
    content: `Every business has the same moment: the message lands at 11pm — "bhai order kab aay ga?" — and nobody sees it until morning. By then the customer has followed up twice, lost patience, and maybe checked a competitor.

WhatsApp is where your customers already are. In Pakistan it is not "a channel" — it is THE channel. Which makes how you handle it a business decision, not a tooling detail.

## Answer speed is the whole game

Most purchase decisions do not wait. A reply in two minutes feels like service; a reply in six hours feels like an apology. The problem is that fast, consistent replies need staffing around the clock — unless software carries the load.

## Automation that does not feel automated

The mistake most businesses make is installing a keyword bot that says "type 1 for X". Customers hate it because it ignores context. The better pattern:

- **Understand the message** — what is actually being asked, in the customer's own words.
- **Apply your business context** — products, prices, policies, the customer's history with you.
- **Do the obvious work** — answer the question, send the order link, book the appointment.
- **Escalate honestly** — when a human adds value, hand the conversation over with full context.

## What "right" looks like

A good WhatsApp automation is invisible. The customer gets an accurate, on-brand answer in seconds, and your team only touches the conversations where a human genuinely matters — negotiation, sensitive issues, closing the sale.

That is exactly what we are building at OmniFlow: one intelligence layer between your business and your customers, WhatsApp first. If you are answering the same questions every day, you are ready for it.`,
  },
  {
    slug: "from-repetitive-questions-to-automated-workflows",
    title: "From repetitive questions to automated workflows: a practical playbook",
    excerpt:
      "The same ten questions eat most of your day. Here is a simple framework for turning them into automated workflows that keep running without you.",
    category: "AI Automation",
    author: "OmniFlow Team",
    reading_minutes: 6,
    published_at: "2026-09-08T09:00:00Z",
    content: `Before software, map the work. Most customer conversations in a small business collapse into a short list: price inquiries, availability, delivery timelines, order status, refunds, appointment requests. Ten patterns, ninety percent of the volume.

## The three-part framework

**1. Capture the intent.** Every incoming message has a job: buy, ask, book, complain. Name your top ten and write down the ideal answer for each — in your words, with your policies.

**2. Attach the context.** The right answer often depends on facts: is the item in stock, has this customer ordered before, what is the delivery time to their city? Automation without context is a keyword bot; automation with context is service.

**3. Decide the action.** An answer is often not enough. The follow-up should be: send the order link, schedule the reminder, notify the salesperson, create the ticket. The action is where a conversation becomes a workflow.

## Where humans fit

Automation is not about removing people — it is about spending them well. High-intent buyers, complaints and edge cases deserve a human. Everything else deserves an instant, accurate reply.

## A simple starting point

Pick your single most repetitive question. Automate the answer and one follow-up action. Measure for a week: hours saved, response time, customer reaction. Then do the next one.

OmniFlow is built to make each of these steps visual — trigger, AI decision, condition, action — so you can build once and let it run.`,
  },
  {
    slug: "what-context-aware-ai-actually-means",
    title: "What context-aware AI actually means for a small business",
    excerpt:
      "Beyond the buzzword: how an AI that knows your products, policies and customers changes the quality of every reply.",
    category: "AI Agents",
    author: "OmniFlow Team",
    reading_minutes: 4,
    published_at: "2026-09-15T09:00:00Z",
    content: `"AI-powered" has become decoration on most product pages. Here is what the phrase should actually mean when a customer message hits your inbox.

## A chatbot matches. Context-aware AI understands.

Keyword bots fail on the sentence your customer actually wrote. Understanding means: this person is asking about the black hoodie, in medium size, they want price and delivery, and they sound ready to buy. Intent, entities, sentiment — parsed from natural language, not from buttons.

## Your business is the context

The answer to "is it available?" depends on your stock. The answer to "can I return it?" depends on your policy. Context-aware AI carries your products, your prices, your policies and the customer's history into every reply — so answers are yours, not generic.

## The context decides the action

Two customers ask the same question and get different — correct — handling. A returning customer with three orders gets an instant answer and an order link. A first-time visitor with a detailed question gets the answer plus an offer to help further. Same message, different right answer.

## Control stays with you

Context-aware does not mean autonomous. You define what the AI may say and do, every action is visible, and a human can step in at any moment. Intelligence is the layer; your rules are the boundary.

That combination — understanding, your context, your control — is what we mean when we say OmniFlow is an AI customer automation platform.`,
  },
];

export function readingLabel(minutes: number): string {
  return minutes + " min read";
}

export function formatDate(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

async function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    return createSupabaseClient(url, key, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            next: { revalidate: 300, tags: ["blog-posts"] },
          }),
      },
    });
  } catch {
    return null;
  }
}

/** Published posts: database first (newest first), seed fallback. */
export async function listPosts(): Promise<BlogPost[]> {
  const client = await supabase();
  if (client) {
    try {
      const { data, error } = await client
        .from("blog_posts")
        .select(
          "slug,title,excerpt,category,author,reading_minutes,content,published_at"
        )
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .limit(50);
      if (!error && data && data.length > 0) {
        return data as unknown as BlogPost[];
      }
    } catch {
      // fall through to seeds
    }
  }
  return SEED_POSTS;
}

export async function getPost(slug: string): Promise<BlogPost | null> {
  const client = await supabase();
  if (client) {
    try {
      const { data, error } = await client
        .from("blog_posts")
        .select(
          "slug,title,excerpt,category,author,reading_minutes,content,published_at"
        )
        .eq("slug", slug)
        .eq("status", "published")
        .limit(1);
      if (!error && data && data.length > 0) {
        return data[0] as unknown as BlogPost;
      }
    } catch {
      // fall through to seeds
    }
  }
  return SEED_POSTS.find((post) => post.slug === slug) ?? null;
}
