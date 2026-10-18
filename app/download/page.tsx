import fs from "fs";
import path from "path";
import type { Metadata } from "next";
import PageShell from "../components/PageShell";
import PageHero from "../components/ui/PageHero";
import Section from "../components/ui/Section";
import Card from "../components/ui/Card";
import Icon from "../components/ui/Icon";
import Button from "../components/ui/Button";
import Reveal from "../components/Reveal";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Get OmniFlow for Android as a direct APK install, or run it on iOS through Expo Go. Offline-ready inbox, live channel status, alerts and analytics in your pocket.",
  alternates: { canonical: "/download" },
};

/** §282: the client APK the page links to, served from /public/downloads. */
const APK_FILE = "OmniFlow-client.apk";

/**
 * Build-time check: the download button only renders once the APK has been
 * copied into public/downloads/ and the site has been redeployed (see
 * docs/MOBILE_APP_GUIDE.md). No fake links, no runtime probing - an honest
 * "not published yet" state until the first build lands.
 */
function readApk(): { href: string; sizeLabel: string } | null {
  try {
    const full = path.join(process.cwd(), "public", "downloads", APK_FILE);
    if (!fs.existsSync(full)) return null;
    const mb = fs.statSync(full).size / (1024 * 1024);
    return { href: `/downloads/${APK_FILE}`, sizeLabel: `${mb.toFixed(1)} MB` };
  } catch {
    return null;
  }
}

const HIGHLIGHTS = [
  {
    icon: "inbox",
    title: "Unified inbox",
    copy: "WhatsApp, Instagram and web conversations in one fast timeline - read and reply from anywhere.",
  },
  {
    icon: "zap",
    title: "Live status",
    copy: "WhatsApp connection health, the AI engine and every workflow at a glance, refreshed continuously.",
  },
  {
    icon: "bell",
    title: "Instant alerts",
    copy: "Local notifications with sounds and haptics - tap an alert and land straight inside the thread.",
  },
  {
    icon: "refresh",
    title: "Offline-ready",
    copy: "Opens with your last-known data even with no network, then syncs itself the moment you are back.",
  },
  {
    icon: "chart",
    title: "Analytics",
    copy: "Traffic, AI performance and guardrail metrics for admins, with 7 and 30 day views.",
  },
  {
    icon: "shield",
    title: "Secure by design",
    copy: "Portal login, server-side tenant isolation and zero direct database access from the device.",
  },
] as const;

const STEPS: Array<[string, string]> = [
  ["Download the APK", "Tap the download button above on your Android phone."],
  [
    "Allow the install",
    "Android will ask to allow apps from unknown sources - accept it for your browser, then install.",
  ],
  [
    "Sign in",
    "Open OmniFlow and log in with your existing portal account. Everything syncs immediately.",
  ],
];

export default function DownloadPage() {
  const apk = readApk();
  return (
    <PageShell>
      <PageHero
        eyebrow="Mobile app"
        title={
          <>
            OmniFlow in your{" "}
            <span className="of-gradient bg-clip-text text-transparent">pocket</span>
          </>
        }
        copy="The full control-plane experience on Android and iOS - built for speed, designed to keep working offline."
      />

      <Section tone="white">
        <div className="grid gap-5 lg:grid-cols-2">
          <Reveal lift className="h-full">
            <Card className="h-full p-7">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand">
                <Icon name="package" />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold text-ink">
                Android - direct download
              </h2>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                Install the OmniFlow APK straight onto your phone. No app store
                needed - download, allow the install when Android asks, and you
                are live in under a minute.
              </p>
              <div className="mt-5">
                {apk ? (
                  <Button href={apk.href} size="lg">
                    Download APK ({apk.sizeLabel})
                  </Button>
                ) : (
                  <p className="rounded-xl2 border border-line-2 bg-soft px-4 py-3 text-sm leading-relaxed text-ink-2">
                    The first APK build has not been published here yet. It will
                    appear automatically as soon as it is uploaded - check back
                    shortly.
                  </p>
                )}
              </div>
              <p className="mt-4 text-xs leading-relaxed text-ink-3">
                Updating: install a newer APK over the old one any time, or let
                the app refresh itself over the air once OTA updates are enabled.
              </p>
            </Card>
          </Reveal>
          <Reveal lift className="h-full">
            <Card className="h-full p-7">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand">
                <Icon name="globe" />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold text-ink">
                iOS - run in Expo Go
              </h2>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                While the App Store release is being prepared, the iOS build runs
                through Expo Go. Install Expo Go from the App Store and request
                the current OmniFlow build link from your account team.
              </p>
              <div className="mt-5">
                <Button
                  href="https://expo.dev/go"
                  variant="secondary"
                  size="lg"
                  target="_blank"
                  rel="noreferrer"
                >
                  Get Expo Go
                </Button>
              </div>
              <p className="mt-4 text-xs leading-relaxed text-ink-3">
                TestFlight and App Store distribution arrive with the store
                release.
              </p>
            </Card>
          </Reveal>
        </div>
      </Section>

      <Section tone="canvas">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-2xl font-semibold text-ink">
            Everything the portal does, at pocket speed
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            One codebase, two apps: the Client app for the daily inbox and
            channel control, and the Admin app for analytics and guardrails.
          </p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {HIGHLIGHTS.map((item) => (
            <Reveal key={item.title} lift className="h-full">
              <Card className="h-full p-6">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl2 border border-brand/15 bg-brand-soft text-brand">
                  <Icon name={item.icon} />
                </span>
                <h3 className="mt-4 font-display text-[16px] font-semibold text-ink">
                  {item.title}
                </h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                  {item.copy}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section tone="soft">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center font-display text-2xl font-semibold text-ink">
            Install in three steps
          </h2>
          <ol className="mt-8 grid gap-4">
            {STEPS.map(([title, copy], index) => (
              <li
                key={title}
                className="flex gap-4 rounded-xl2 border border-line-2 bg-white p-5 shadow-[0_1px_2px_rgba(11,18,32,0.05)]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft font-display text-sm font-semibold text-brand">
                  {index + 1}
                </span>
                <div>
                  <h3 className="font-display text-[15px] font-semibold text-ink">
                    {title}
                  </h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                    {copy}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Section>
    </PageShell>
  );
}
