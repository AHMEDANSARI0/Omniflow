import type { Metadata } from "next";
import { ArrowRight, CalendarDays, Clock } from "lucide-react";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";
import { formatDate, listPosts } from "../../lib/blog";
import { SITE_ROUTES } from "../../lib/marketing/site";
import { getCopy } from "../../lib/marketing/cms";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Insights for the automated business: AI automation, WhatsApp automation, customer support and workflow playbooks from the OmniFlow team.",
  alternates: { canonical: "/blog" },
};

export default async function BlogPage() {
  const [posts, heroes, pagesCopy] = await Promise.all([listPosts(), getCopy("page_heroes"), getCopy("other_pages")]);
  const blogCopy = pagesCopy.blog;
  const [featured, ...rest] = posts;

  return (
    <PageShell>
      <PageHero hero={heroes.blog} />

      <Section tone="canvas">
        {featured ? (
          <Reveal lift>
            <Card className="overflow-hidden">
              <a
                href={"/blog/" + featured.slug}
                className="grid gap-0 lg:grid-cols-[1.1fr_1fr]"
              >
                <div className="p-8 sm:p-10">
                  <Badge tone="brand">{featured.category}</Badge>
                  <h2 className="mt-4 font-display text-[26px] font-semibold leading-snug tracking-[-0.02em] text-ink sm:text-[30px]">
                    {featured.title}
                  </h2>
                  <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                    {featured.excerpt}
                  </p>
                  <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-ink-3">
                    <span className="font-medium text-ink-2">
                      {featured.author}
                    </span>
                    {featured.published_at ? (
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                        {formatDate(featured.published_at)}
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" aria-hidden />
                      {featured.reading_minutes} min read
                    </span>
                  </div>
                  <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-brand-2">
                    {blogCopy.readArticle}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </span>
                </div>
                <div className="relative hidden min-h-[260px] items-center justify-center border-l border-line bg-[linear-gradient(180deg,#F5F4FF_0%,#FFFFFF_100%)] lg:flex">
                  <div aria-hidden className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(99,91,255,0.14),transparent_70%)]" />
                  <p className="relative px-10 font-display text-2xl font-semibold leading-snug text-ink">
                    {blogCopy.featuredQuote}
                  </p>
                </div>
              </a>
            </Card>
          </Reveal>
        ) : null}

        <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {rest.map((post) => (
            <Reveal key={post.slug} lift>
              <Card className="flex h-full flex-col p-6">
                <Badge tone="brand">{post.category}</Badge>
                <h2 className="mt-4 font-display text-[17px] font-semibold leading-snug text-ink">
                  <a href={"/blog/" + post.slug} className="hover:text-brand">
                    {post.title}
                  </a>
                </h2>
                <p className="mt-2.5 flex-1 text-[13.5px] leading-relaxed text-ink-2">
                  {post.excerpt}
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-3">
                  {post.published_at ? (
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                      {formatDate(post.published_at)}
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" aria-hidden />
                    {post.reading_minutes} min
                  </span>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className="mt-12 text-center">
            <Button href={SITE_ROUTES.start} variant="secondary">
              {blogCopy.indexCta}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </Reveal>
      </Section>
    </PageShell>
  );
}
