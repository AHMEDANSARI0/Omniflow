import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CalendarDays, Clock } from "lucide-react";
import PageShell from "../../components/PageShell";
import Section from "../../components/ui/Section";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import Reveal from "../../components/Reveal";
import Container from "../../components/ui/Container";
import { formatDate, getPost, listPosts } from "../../../lib/blog";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return { title: "Article not found" };
  return {
    title: post.title,
    description: post.excerpt,
    openGraph: {
      type: "article",
      title: post.title,
      description: post.excerpt,
      publishedTime: post.published_at ?? undefined,
    },
  };
}

/** Renders the stored markdown subset: ## headings, - bullets, paragraphs. */
function ArticleBody({ content }: { content: string }) {
  const blocks = content.split("\n").filter((line) => line.trim().length > 0);
  return (
    <div className="space-y-5">
      {blocks.map((line, index) => {
        const text = line.trim();
        if (text.startsWith("## ")) {
          return (
            <h2
              key={index}
              className="pt-4 font-display text-[22px] font-semibold tracking-[-0.01em] text-ink"
            >
              {text.replace(/^##\s+/, "")}
            </h2>
          );
        }
        if (text.startsWith("- **") || text.startsWith("- ")) {
          const label = text.replace(/^-\s+/, "");
          const bold = label.match(/^\*\*(.+?)\*\*(.*)$/);
          return (
            <p key={index} className="flex items-start gap-3 text-[15.5px] leading-relaxed text-ink-2">
              <span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              <span>
                {bold ? (
                  <>
                    <strong className="font-semibold text-ink">{bold[1]}</strong>
                    {bold[2]}
                  </>
                ) : (
                  label
                )}
              </span>
            </p>
          );
        }
        return (
          <p key={index} className="text-[15.5px] leading-[1.8] text-ink-2">
            {text}
          </p>
        );
      })}
    </div>
  );
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  const all = await listPosts();
  const related = all.filter((item) => item.slug !== post.slug).slice(0, 2);

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.excerpt,
    author: { "@type": "Organization", name: post.author },
    datePublished: post.published_at ?? undefined,
  };

  return (
    <PageShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <article>
        <section className="of-hero-glow relative overflow-hidden bg-canvas">
          <Container className="pb-12 pt-28 sm:pt-32 lg:pt-36">
            <div className="mx-auto max-w-3xl">
              <a
                href="/blog"
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-2 hover:text-brand"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                All articles
              </a>
              <div className="mt-5">
                <Badge tone="brand">{post.category}</Badge>
              </div>
              <h1 className="mt-4 font-display text-[32px] font-semibold leading-[1.12] tracking-[-0.02em] text-ink sm:text-[42px]">
                {post.title}
              </h1>
              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink-3">
                <span className="font-medium text-ink-2">{post.author}</span>
                {post.published_at ? (
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                    {formatDate(post.published_at)}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  {post.reading_minutes} min read
                </span>
              </div>
            </div>
          </Container>
        </section>

        <Section tone="white" containerClassName="!py-14 sm:!py-16">
          <div className="mx-auto max-w-3xl">
            <p className="mb-8 border-l-2 border-brand/40 pl-5 text-[16.5px] font-medium leading-relaxed text-ink">
              {post.excerpt}
            </p>
            <ArticleBody content={post.content} />

            <div className="of-cta-gradient mt-14 rounded-xl3 px-7 py-8 text-center sm:px-10">
              <p className="font-display text-xl font-semibold text-white sm:text-2xl">
                Ready to put your conversations on autopilot?
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <Button href="/dashboard/login" variant="dark">
                  Get Started
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
                <Button href="/features" variant="night-outline" className="border-white/40">
                  Explore features
                </Button>
              </div>
            </div>
          </div>
        </Section>

        {related.length > 0 ? (
          <Section tone="canvas" containerClassName="!py-14">
            <h2 className="font-display text-xl font-semibold text-ink">
              Keep reading
            </h2>
            <div className="mt-6 grid gap-5 md:grid-cols-2">
              {related.map((item) => (
                <Reveal key={item.slug} lift>
                  <a
                    href={"/blog/" + item.slug}
                    className="block h-full rounded-xl3 border border-line bg-white p-6 shadow-card transition-all duration-300 hover:-translate-y-1 hover:shadow-card-hover"
                  >
                    <Badge tone="brand">{item.category}</Badge>
                    <p className="mt-3.5 font-display text-[16px] font-semibold leading-snug text-ink">
                      {item.title}
                    </p>
                    <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-ink-2">
                      {item.excerpt}
                    </p>
                  </a>
                </Reveal>
              ))}
            </div>
          </Section>
        ) : null}
      </article>
    </PageShell>
  );
}
