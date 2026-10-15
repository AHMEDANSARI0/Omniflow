// add_batch_166_170.mjs - one-file batch covering Phases 166-170.
//
//   Ph166  The chat thread renders its first paint from the server.
//          page.tsx becomes a server wrapper that resolves the route id
//          and fetches conversation + messages through the existing
//          getConversation client while the HTML streams, and the whole
//          former client page lives on as ThreadClient.tsx seeded with
//          initialConversation / initialMessages. The 10s poll, search,
//          older-messages loading and every feature stay untouched.
//   Ph167  The thread route drops framer-motion: its single entrance
//          animation becomes a CSS keyframes class, so opening a chat
//          hydrates a smaller bundle.
//   Ph168  The broadcasts history seeds server-side too (server page.tsx
//          + BroadcastsClient.tsx, history + loaded state pre-filled).
//   Ph169  The public-site chat widget waits for idle before mounting:
//          the bubble no longer competes with the page for hydration
//          work during first load.
//   Ph170  Regression coverage + both repos' .gitignore gain *.pre_*.bak
//          so patcher backups never land in git when staging everything.
//
// Zero AI. Website only. Vercel deploys on push. NO restart, NO CP change.

import fs from "node:fs";
import path from "node:path";

const BACKUP_TAG = ".pre_b166170.bak";

const THREAD_SERVER_PAGE = `import { getOmniFlowSession } from "../../../../../lib/omniflow/auth-dal";
import {
  getConversation,
  requirePortalAccessToken,
  type ConversationMessage,
  type ConversationSummary,
} from "../../../../../lib/omniflow/portal";
import ThreadClient from "./ThreadClient";


export default async function ConversationThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getOmniFlowSession();

  let initialConversation: ConversationSummary | null = null;
  let initialMessages: ConversationMessage[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    const conversationId = Number.parseInt(id, 10);
    if (accessToken && Number.isFinite(conversationId)) {
      const detail = await getConversation(accessToken, conversationId);
      if (detail.kind === "ok") {
        initialConversation = detail.conversation;
        initialMessages = detail.messages;
      }
    }
  }

  return (
    <ThreadClient
      conversationId={id}
      initialConversation={initialConversation}
      initialMessages={initialMessages}
    />
  );
}
`;

const BROADCASTS_SERVER_PAGE = `import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listBroadcasts,
  requirePortalAccessToken,
  type BroadcastRow,
} from "../../../../lib/omniflow/portal";
import BroadcastsClient from "./BroadcastsClient";


export default async function BroadcastsPage() {
  const session = await getOmniFlowSession();

  let initialHistory: BroadcastRow[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const result = await listBroadcasts(accessToken);
      if (result) initialHistory = result.broadcasts;
    }
  }

  return <BroadcastsClient initialHistory={initialHistory} />;
}
`;

const THREAD_TRANSFORMS = [
  {
    name: "p166-thread-signature",
    from: `export default function ConversationThreadPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";`,
    to: `export default function ThreadClient({
  conversationId,
  initialConversation,
  initialMessages,
}: {
  conversationId: string;
  initialConversation?: ConversationSummary | null;
  initialMessages?: ConversationMessage[] | null;
}) {
  const id = conversationId;`,
  },
  {
    name: "p166-thread-conversation",
    from: "const [conversation, setConversation] = useState<ConversationSummary | null>(null);",
    to: "const [conversation, setConversation] = useState<ConversationSummary | null>(\n    initialConversation ?? null\n  );",
  },
  {
    name: "p166-thread-messages",
    from: "const [messages, setMessages] = useState<ConversationMessage[] | null>(null);",
    to: "const [messages, setMessages] = useState<ConversationMessage[] | null>(\n    initialMessages ?? null\n  );",
  },
];

const THREAD_CLIENT_TRANSFORMS = [
  {
    name: "p166-thread-useparams-import",
    from: 'import { useParams, useRouter } from "next/navigation";',
    to: 'import { useRouter } from "next/navigation";',
  },
  {
    name: "p167-motion-import",
    from: `import { motion } from "motion/react";

const MESSAGE_URL_PATTERN = /(https?:\\/\\/[^\\s]+)/g;`,
    to: `const MESSAGE_URL_PATTERN = /(https?:\\/\\/[^\\s]+)/g;`,
  },
  {
    name: "p167-motion-open",
    from: `        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-3"
        >`,
    to: `        <div className="of-fade-up space-y-3">`,
  },
  {
    name: "p167-motion-close",
    from: "</motion.div>",
    to: "</div>",
  },
];

const BROADCASTS_TRANSFORMS = [
  {
    name: "p168-broadcasts-signature",
    from: "export default function BroadcastsPage() {",
    to: `export default function BroadcastsClient({
  initialHistory,
}: {
  initialHistory?: BroadcastRow[] | null;
}) {`,
  },
  {
    name: "p168-broadcasts-history",
    from: "const [history, setHistory] = useState<BroadcastRow[]>([]);",
    to: "const [history, setHistory] = useState<BroadcastRow[]>(initialHistory ?? []);",
  },
  {
    name: "p168-broadcasts-loaded",
    from: "const [loaded, setLoaded] = useState(false);",
    to: "const [loaded, setLoaded] = useState(initialHistory !== null);",
  },
];

const WIDGET_TRANSFORMS = [
  {
    name: "p169-widget-gate",
    from: `export default function WebsiteChatWidget() {
  const pathname = usePathname();`,
    to: `export default function WebsiteChatWidget() {
  const [widgetReady, setWidgetReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setWidgetReady(true), 1_500);
    return () => window.clearTimeout(timer);
  }, []);

  if (!widgetReady) return null;
  return <WebsiteChatWidgetSurface />;
}

function WebsiteChatWidgetSurface() {
  const pathname = usePathname();`,
  },
];

const GLOBALS_APPEND = `
@keyframes of-fade-up {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.of-fade-up {
  animation: of-fade-up 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
}
`;

const GITIGNORE_LINE = "*.pre_*.bak";

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function splitClientPage(pagePath, clientName, transforms, serverPage, label) {
  const clientPath = pagePath.replace("page.tsx", clientName);
  const pageText = fs.readFileSync(pagePath, "utf8").replace(/\r\n/g, "\n");

  if (fs.existsSync(clientPath) && pageText.includes(clientName.replace(".tsx", ""))) {
    alreadyTotal++;
    console.log("= " + pagePath + " (split already done)");
    return;
  }
  if (!pageText.includes('"use client"')) {
    warnTotal++;
    console.log("  ? " + pagePath + " :: " + label + " unexpected page shape — report this");
    return;
  }

  let clientText = pageText;
  for (const swap of transforms) {
    const fromCount = clientText.split(swap.from).length - 1;
    if (fromCount !== 1) {
      warnTotal++;
      console.log("  ? " + pagePath + " :: " + swap.name + " NOT FOUND — report this");
      return;
    }
    clientText = clientText.replace(swap.from, swap.to);
  }

  const backup = pagePath + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(pagePath, backup);
  fs.writeFileSync(clientPath, clientText, "utf8");
  fs.writeFileSync(pagePath, serverPage.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal += 2;
  console.log("+ " + clientPath + " (new): " + label);
  console.log("+ " + pagePath + " (server wrapper): " + label);
}

const THREAD_PAGE = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";
const THREAD_CLIENT = "Omniflow/app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx";
const BROADCASTS_PAGE = "Omniflow/app/dashboard/(portal)/broadcasts/page.tsx";
const BROADCASTS_CLIENT = "Omniflow/app/dashboard/(portal)/broadcasts/BroadcastsClient.tsx";

if (fs.existsSync(THREAD_PAGE)) {
  splitClientPage(THREAD_PAGE, "ThreadClient.tsx", THREAD_TRANSFORMS, THREAD_SERVER_PAGE, "p166-thread-split");
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + THREAD_PAGE);
}

if (fs.existsSync(BROADCASTS_PAGE)) {
  splitClientPage(BROADCASTS_PAGE, "BroadcastsClient.tsx", BROADCASTS_TRANSFORMS, BROADCASTS_SERVER_PAGE, "p168-broadcasts-split");
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + BROADCASTS_PAGE);
}

const TARGETS = [
  {
    file: THREAD_CLIENT,
    swaps: [
      { name: "p166-thread-useparams-import", from: 'import { useParams, useRouter } from "next/navigation";', to: 'import { useRouter } from "next/navigation";', guard: 'import { useRouter } from "next/navigation";' },
      { name: "p167-motion-import", from: `import { motion } from "motion/react";\n\n\nconst MESSAGE_URL_PATTERN = /(https?:\\/\\/[^\\s]+)/g;`, to: `const MESSAGE_URL_PATTERN = /(https?:\\/\\/[^\\s]+)/g;`, guard: "", deleteOk: true },
      { name: "p167-motion-open", from: `        <motion.div\n          initial={{ opacity: 0, y: 12 }}\n          animate={{ opacity: 1, y: 0 }}\n          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}\n          className="space-y-3"\n        >`, to: `        <div className="of-fade-up space-y-3">`, guard: "of-fade-up space-y-3" },
      { name: "p167-motion-close", from: "</motion.div>", to: "</div>", guard: "", deleteOk: true },
    ],
  },
  {
    file: "Omniflow/app/components/WebsiteChatWidget.tsx",
    swaps: [
      { name: "p169-widget-gate", from: `export default function WebsiteChatWidget() {\n  const pathname = usePathname();`, to: `export default function WebsiteChatWidget() {\n  const [widgetReady, setWidgetReady] = useState(false);\n\n  useEffect(() => {\n    const timer = window.setTimeout(() => setWidgetReady(true), 1_500);\n    return () => window.clearTimeout(timer);\n  }, []);\n\n  if (!widgetReady) return null;\n  return <WebsiteChatWidgetSurface />;\n}\n\nfunction WebsiteChatWidgetSurface() {\n  const pathname = usePathname();`, guard: "widgetReady" },
    ],
  },
];

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.guard && text.includes(swap.guard) && !text.includes(swap.from)) {
      alreadyTotal++;
      continue;
    }
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && (toCount === 0 || swap.deleteOk)) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);
  fs.writeFileSync(target.file, text, "utf8");
  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

const GLOBALS_PATH = "Omniflow/app/globals.css";
if (fs.existsSync(GLOBALS_PATH)) {
  const globalsText = fs.readFileSync(GLOBALS_PATH, "utf8").replace(/\r\n/g, "\n");
  if (globalsText.includes("of-fade-up")) {
    alreadyTotal++;
    console.log("= " + GLOBALS_PATH + " (fade-up already present)");
  } else {
    const backup = GLOBALS_PATH + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(GLOBALS_PATH, backup);
    fs.writeFileSync(GLOBALS_PATH, globalsText + GLOBALS_APPEND.replace(/^\n/, "\n"), "utf8");
    appliedTotal++;
    console.log("+ " + GLOBALS_PATH + " (1): p167-fade-up-css");
  }
} else {
  warnTotal++;
  console.log("SKIP (file not found): " + GLOBALS_PATH);
}

for (const ignorePath of ["Omniflow/.gitignore", "OmniFlow-Control-Plane/.gitignore"]) {
  let ignoreText = "";
  if (fs.existsSync(ignorePath)) {
    ignoreText = fs.readFileSync(ignorePath, "utf8").replace(/\r\n/g, "\n");
  }
  if (ignoreText.includes(GITIGNORE_LINE)) {
    alreadyTotal++;
    continue;
  }
  const backup = ignorePath + BACKUP_TAG;
  if (fs.existsSync(ignorePath)) {
    if (!fs.existsSync(backup)) fs.copyFileSync(ignorePath, backup);
    fs.writeFileSync(ignorePath, ignoreText + (ignoreText.endsWith("\n") || ignoreText === "" ? "" : "\n") + GITIGNORE_LINE + "\n", "utf8");
  } else {
    fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
    fs.writeFileSync(ignorePath, GITIGNORE_LINE + "\n", "utf8");
  }
  appliedTotal++;
  console.log("+ " + ignorePath + " (1): p170-gitignore-backups");
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);