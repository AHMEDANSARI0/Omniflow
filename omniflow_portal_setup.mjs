#!/usr/bin/env node
/**
 * OMNIFLOW — PORTAL UPDATE patch (single file). COMPACT (deflate).
 * Portal WhatsApp channel + AI agent config + connector API (backend module).
 *
 *         node omniflow_portal_setup.mjs
 *
 * Kis repo mein chalao:
 *   - WEBSITE repo root (jahan package.json hai)  -> docs + sidebar/proxy check
 *   - BACKEND repo root (jahan app.py hai)        -> backend files (composite WSGI app.py samet)
 *
 * Dono repos aik hi parent folder mein hain to sirf AIK dafa chalao —
 * script doosri repo khud dhoondh kar patch kar degi.
 *
 * Optional:  node omniflow_portal_setup.mjs --push   (commit + push bhi)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";

const WEBSITE_FILES = {
  "docs/PORTAL_API.md": ["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",3531],
};

const BACKEND_FILES = {
  "app.py": ["jVbNcuI4EL7rKbrMxa6Amdna01RxyCYky+5MYCG7MzdF2G2siiwpahnIbR9in3CfZEs2JkAgtZyM+vu61f+Koui+1jIzTsMV/IUuQwWovXsFa6T2UBgHvkSYVlreKbOBG6O9MwpmSmiE69kE1p/TKIoYk5U1zoOh7oteiRXOVGCFL5Vcwu58JnzJGJvNp7+Nbx75fDp9hFFzGnNeSIWcJ6lDMmqNcZJa4VB7tpjf8NvJPCAPiUOIyGXBfAHkXbyDJaCNB6nDJdJg/wsDgP2/VGpC5+NP/SNSwlgP5ljUhGCVkNrj1sPMkF85XPzxFbwTmhoncI0aZAECrDNrmaODP+dfwVTSExCpyuSYMkMp6rV0RqeEPsdC1MrH0ex+sfj6bXo7jvoQOXyppcMoYW20CiXouYvVXfMHeqDNi/gC458//bSDZW0iuA2JSEvvLRdWdrzMofDIj0CN/FhVo0nUvuRWEG2My7lDQt+pWVoQdA7Al/asqrySmteEjk5UvAkuUANYKJ6VQmtUJ/QT4ccqlsafZS/NpWtnRmvMvHGHIWy5R6KP7YYw7clS59wZ47mwVslMeGn0aR5ZDwaDAYy3HjUFOeq8aTuCuAs3tPm4aiMIVztjcPV2syRoGQwGrHcx7XECDn3tNDXdvGvipodDC39f3E9g44S16PqwKWVWsh7kBqlpI9xaQ9gw23qUmrzQGfaBTHOMnQsESq4xNJ4vUTowG816QJVQascV1oLQwa+XGskTCIeQS7LCZyXmsHwN9pTMpG86yjos5BYpZaLehmjCqNUUR6bSslBmw9/MR0kHSx2uJHl0fKlqtE5qH58v5I8pR4X7IfR9kf4feFuVHyJPazBhjI9/PI4fFpPpA5/Nx3eTH+MFjCBuhlw0FFYO15+Hwd1hYdzK+EHnddQ/g2kicRkSQjBsQnBe1NIzk+M7QOvk8PR471GQJIyxTAki4Demsoakx++0ku3IjqLotqsOeiu0ZqkQeAO7wPXDSHavvpR6BahCvba1eT2btAsqaMuxAM6llp7zmFAVfbBOVsK99oOipLXZrApURcp3Qhh1sBO5qLcwCsxD9ZlQaq9+N//DohHOh6KzRhMeWAqewKgDpisMG+L68Vc+ebibhg0RJXusLBp42iijjQw7830pHCgPv7b1324cX7oTO8vYeX6ZxdjhkBudpDG+PJT6XfKaxTtrJ9vBLFkLJXPhEbKavKnQwS8oHDrw5hk1hVkh6DkkPCT62/XkIYwX1gPpw9UhlnpgncmQCO7Hj3BU9BUm8O/f/zSjuuFn3a0hDG4o0WHKzg7y+OC7ufru5ZRLysw6LL9mKB68o3zpTL0qQYA3dqBwjQqenoS1T0+wFk6KpcKU9eB3RNsKOv1PT/tHGG4l+eDt/s12YCJl7Ww8oLL/AA==",2527],
  "auth_password_reset.py": ["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",9771],
  "admin_users.py": ["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",6655],
  "portal_auth.py": ["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",4296],
  "portal_db.py": ["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",4244],
  "portal_channels.py": ["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",5027],
  "portal_bot.py": ["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",9446],
  "connector_api.py": ["3Vr9jts2Ev9fTzEQUFRCFcdpesCdUafn7Drtohs72HWaFnsLlZZom7FMqiS1jrNd4B7invCe5MAPUV/WbraHw7VdILFFDofk8Dczv6Hs+74331HyKmN7OGFUcpbBmwxRDP/+57/gZD6bTU8W8wvANM0ZoVJA8G6DpJjkOSSMUpxIxmHJSbrG4cDzfsI10aQQku0why0GlFMMKb4hCYZgw3YYMpRLloeQIw7JBmUUwx5luFLrbTFk5IBhgwjV6xGY32CuR7hVCCwEYRS+n7z87gwo2hCtTaIBTAq5GXk/PlE7XGVs/+R7fIANRinmMIb569nZq/P5u/hyevHD2ck0/n76ExxQ1T45fX02iydvzlSPF+yV6pyzG0whR1JiTuE9A5TuCK1tuhAYtohLs2xlkxNnpy0CiSmiEjgWLLvBsGESKUEIcrzJEOyQTDbwHmOJwpEH8GwAF/iXAgsJS5Yenv5SYH6AHQb8Ic9IQiT8nGQEUxmT9GcP4MsBvETJFtMUML2p9uJOMn57Ob2Ip68nZ+fw5AXkGZIrxndxITAXkDG2LXLPm5bbUWt4M79cwFOUk6c3z56603m6VyeA8vypkEgWAtzfrWrAEeQbRvE3EaAkYQWVMUU79ejW+82dB/DtdAH3KU/Ybodo6tR/k5EdkeMvh6BMRlNC1xGwLFUWWhEuZPgJKy6VPkXJVq/YNsQkjYBtI6BMfvJSl0zC0b/AnvUWAVpjKhWyV2Qder7vex7Z5YxLyNh6Tei6fGSi/CZwwrF0j3LDMUprkpLssLfibAcpklg9ge0pnyMt85FRKycPOaHrUmpCDxGckkRGMM8lYRRlnpFbZUhsS7GXWYFzTqiM4L1glKwOEXCDSLcH9R/K4nTpeZ7aj3Yvu7HBGstz3Rb4zPrhwBnvCcqJH3reModxNVXgO4FYCUQQa/DEcQQFz+Kc4xX5MPY7Z6FUTc7P5++mp/HlYrKYXsIYAj8lworg1I+g1E7ouvaEUz/04sV0Npkt4sXiPL6cnsxnp0rD8+FwMPRic5xxxpItjKsDGZyzZBuErj9ByQaPtGmvhOSRsvQ1jOHWxztEMn8EM0ZxBP4NygpcPSLpj2A4GN55npfiFcSokBvGyUecBqHy1SVjmfJHgC0+wLg8hoGJaEJZOvCb0U7tzw/1GLJSqFZDjQ71x7EsOIVXKBNYN6IkwbnEKYzhykkxMcD0hnBGzRTHAqcfRg/LNwJqOeLaq60E0UOwhZUKlUBotRyygi0gmpZeMUjYLkccxylZYyGDLT5EsA1Dz/P+vswHS7xiHMclTrU11wXiaRCOSmOU1tthuWEpjMfgz98szuazS79jIHVCdSM2jqYjbf0kuPUx54z7I7j1E5aqo/ZXjC9JmmLqV/bq//N3WAi01iMvMdfJU539jgihXJlxIPQGZSQd+Hd3YQRfDZ+X6LEZxqIyKPNF7GLaSAFTA6v0/6smZq/Nznzfd2PA6YEXOsFoSNu0EQ60oWCsbWSCXcHRMsMDFfGs/YggVEhEE3xkTREQKkN90krHA7LKIUL4R8OQamhXFl7AsHNOt9W+/BEcm8BXWdF0WycVrOCJPg+LH//O03qNIcb94D+WgY17DoTkJA/CQcb2mAcNd9Vqj+NRN1K2V7GI7PBA/WcH74ncQD1eVRp0dFL+HTTM1gheVzZSXSuv0F87Jm7Jm1B2DUToVTt/qQ8J1FqfwCpjSAat8Uj612EIX8ORAOwUhe4bWdl9jBqzWOukJOlMYBcYGqupkA/jKm8NYtVijSd5LUJqS6rOQVJwwXgQAlLEljdnTgo+wB9wUkgcdPzav5yeT08WoBBVIfLVxfw1+PBFfRW/BNWDQsllvJi8PJ+G8EVXKbz7bnoxfUiDwVl8Mj8P4QvwYQyfCTg/e322gGdHQlCgTzsKmz1h42nFCpo2rMfZXgRJwY3cilCUZTUbGvNlTCh41sGtNfUHW0ufxi1H1aOuhtdXtdbrhq9WErar8lpMb/y7h3ykgZ1BkStCFVTp29ioyt9GuszglO3vQq8NRyMTlsHZTsB4rFNEb3QedRHprPJwhDfLwB9UEoWp/lCVEhKgZz1q+QiCMn9VB2y/FRTdIJKpiB5oDRH4zXrGD6+G12EEfxk+d2HMShCh9T80aS1pNlDnMmhFDSmTcZllFLHzelLnEY+sSrJWPabrx02BRq1yq/Lb5Qa/x4SC39V6QLC0xZcqUe8vvgRWlQHHhA6aqmrOp3O6s6U1WAk3kwQMnpT1YrViwxSbedyYPEeHjKG0xhvXWOqBgSAZpnK84AVuzFQOaWZt2xppYIeAM4Hh1pFWbbFYkXjF2EegV5HiFSoyOQJdR2Rsb79tyHozMin/yQv1aZbK0b62TMTXhtsqhRWfbTiFdkUYKxUBR/sG8IPFIcdTA9cflJz+3qVtdpF1A+zQhyBj+wh2hAZqsZGZyRHNnAkZ+O1S2A+1LThWfhObtpInVsdQP7RavIuMcyqBdpSwYw2xqIJf6FztuFvrVhN4dWWuYnddk26sqgQjo+kXhWY19Siqu0RpycAfTXbNGup1269V0fara4QNo475Do19N4aCNnaoG+0OnYD6LKlXG+IbHZSE5BbfLifV7zLas9T77GQt8fpjz9R1kc4KusCvYjSmouA4lio6iyBsZN9ertPR9wjO8yDv0Yd6NrucXizgbLaY38dVFL7e3kN3DOUJaty8fsnUvGOKIENCxgJjGiMZ+T3KjHviNF4eIjBJPo2RDKFnwA+T87fTSwg+ExHU/83m74Kw9rVXwXymLlRfnZ+dLGo7CeF0Dm/fnE4WU7icLvoGO9ed/nhy/vZ0ejowBugTL2HuxI2h+sRbQHWjGnbtG1w3d33wY4+hPrZ+On1Dq0ODsbF9T6Cx9KvFGO9DUDmgJJXXYVdzkxYbh2G7HZE15+qQ4Q4hfhxFexQ32yOwd7N7TmSdnHne0SDOtv4IFA1QEfXL4dBmOR3durenNs1lRCgeZtrKNKeSdiuHf1qOc9n+0QlONejLYaW2oiG+bvPVfiJ4pnYf/hHjaK2GRInCSASOiCUcl35gqsqjKnpj78nr04cCr6k1KxKsy8jJ7LTE1xg+t5fxn/c56/zidHoBL38CksLk8sQWoZ+JR7msPssHXfFTqtT/u3O6FxvqGrnjmq53DFfmhlRdinK2V6SsVTfb41fuxvbWdxwi/MatSY1oWJHIvS4w1262eSA/Erpi3aqtOWEpzXGeoQQHZtS4fO8wKGRS9yCzpwHKFViCVoGnS3e3A+X2rYrO4L4uZFvagtYx6pJlU6juTG/vWgNq5hq5PRHB1JsxJDsc7YjpHEerFW/h8SDrwufIWaQZbttFRf1tlY25KNmWIff3UVhUL9DarLjqqUqMui1rb97MfS7j7bvfuowuFhmvT/j1+Mjl7v+qMqnNG+RMEElusFnUR8QZ40S9zW3VJGwbrzK0bluGbf1QOZhKuPYyt1ucqTZrONutP5pGVE1/hmLB0mD/v8pVikS7tKRYOceiyGRszadausSxj3abxFfPeK0keDFdvL2Ync2+BZL2pTI/VeWnOrMSCfqU/BUimX4jac6vDvMj2e+T0p7d2QOJ73fKV60BQMe5VkK0V8Z2f49yd3VPqFPmo539xC5I3wruSFY59le/gUAvmbThu7rDXLo7zDKOPxisO/divy1i/yHpr/4dRVmi6bJtzTGW+kcgK5Rl6vq1t1zcM74ldB1vWMFFjKnaYhq1moVEXEYd2bRX66bYIRpvEE3ZalVprUJM38CHXgC9nC9+Cy1/DJ/+szBp9zs0Jo/T6XtfODn3bdFNhzUVCtyv5CZCEJV229TBV3jUr/g5wTTNDu3+EqlKpt1XYvdY31HY+iPzq417ZTWWlcrh30bD4UN6lU7/2V+PSB6FeM8KargfdQixjYna9vrFdfmmzmvmLkfba9qOkUfb3a5hbHNvDVNNVEo+WL/0QqUJk6oyqVo1Xb0fPyV23HD9rMuOThOFoAYx8HPOVuYnkCizP2dKiFCilmR04ViHotPv2sx66+I1dDpx19YV7wOsG3tcwHHhXlUlnnsUmW6znjbij6K9d0G2Tux4Q68nOE3HBY5treEoJQ77a84jUG/VnKV7/Qc=",11220],
  "migrations/007_password_reset_tokens.sql": ["lZLBbtMwHMbveYrv2EgNCiCKRMUh3dxikSYj8UTHJbJib7Fo7Sh26XbjxAOgPeGeZKpDs1KBpvlkyfbv+/76OYqQb7Sar80ODz/vgSVdFAmjeYY4fv8BLbd2ZzqBTlrp4Mx3qS1GGfmKjbrpuFNG+4fCIMsZnNnWDeL4dRTHkzCIIhRbjTw7I1AamTQatdHWrCUefv1G+SUFEcqZ7lUQnBUkYQQsmaUEdO55ZEVLVg41Kl+jOtQIAEAJHNaMLkpS0CTFRUGXSXGFz+Rq7G9treyq/uqMLmjGPD67TNP+3COrhtsGjKyOTvH3iiKUn5LozbsJzDVcIzGJhLpRDrUREqN2zZXu91r+kB2sM50UoQ+Rt63qpK24A6NLUrJkecG+nTThzslN6yyA45o4J/PkMmWIx0OTa67WUvRpw7NRzVt8xNvwMLfY5wHHkadTedpe8K6RvaHtRoopjK6lR4z7EGUhJBeeXHeSux7+r2GGvtrsRmEQTgfBNDsnqxPBStxWJ5L3xnxQnv3P/x+p4fSF6L3mZ9BP/+HFdG/57hn+01cIp8Ej",902],
  "migrations/008_portal_connector.sql": ["tVTBbtNAEL37K+aWRDRVuJVwcloHGVy7JK5ouazG3km8zXrXeNdqDULiI/hCvgStk7S0SaoixM1ev3n75s0bD4eQlEpMpb6FU61srSVcSFQEv378hFIsa7RCKxiNTsZQ6dqihFeQa6Uot7oGi5kk4w2HEHIqK21JWeiHU4iTFIKrcJ7OBx1VXmDRElgNMWkF848REBeOoiTgOsMaISuEw0mEG2zp2LHGSRqMIcN8RYpDqXkjCfprIYxnx1U7AEfbyQCJX4VsYVU0vCPLUCFwsggFiiPH1xIshCSgu0qKXFjAyj2sm1wRSNGSAx973uks8NMAUn8SBfCoo40R7LZAa7CqmLFoGwN9DyCXgpRlgsMkfBfGKVzMwnN/dg0fgusjD8BBCdLgKu0I48sogrNg6l9GKfS4MBtrifccuiq0WqPdG+a5bpRlCsuHQ4nGMkOkGFpIw/NgnvrnF+ln960mp5Q4y9qNHHfaVBzd4WP8rpw4+dQfeIO3L7Ei05blWi3E8mU24JL+bGSPF/ex9I0RxqKynSN2a8iekkUtSHHZdsBlTWSFWh4Cd6AFSunC9SzoVtcroZas0E1tGCmXNQ6TJIkCP94tmvrRPNitMxZre+ie0ZvxaLT3Mn6o5PXJtqRoSlSsQMX1YvEX+rY5+O/huP9dsFyXJSq+zsg6HPNgFvrR03zs5GcroPtYoFIkDzmzXcveeme61X4E7TYLW6mRw/t5Ek/2kHz73huPb4xW2XZrG3PowooUF2rZW6/cl4bMjq01mUZaprR92Ny8ppdb/U+zCeOz4OrJbAS/Y9v5lNywTRMeQBI/N7j7yRxtXDkCwQdvvd8=",1610],
};

function unpack([dataB64, size]) {
  const buf = inflateRawSync(Buffer.from(dataB64, "base64"));
  if (buf.length !== size) {
    throw new Error("size mismatch — script copy adhoora hai (dobara copy karein)");
  }
  return buf;
}

const root = process.cwd();
const doPush = process.argv.slice(2).includes("--push");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

function info(msg) { console.log(CYAN + "==> " + OFF + msg); }
function ok(msg)   { console.log("  " + GREEN + "+" + OFF + " " + msg); }
function warn(msg) { console.log("  " + YELLOW + "!" + OFF + " " + msg); }
function fail(msg) { console.error(RED + "ERROR: " + OFF + msg); process.exit(1); }

function detectType(dir) {
  if (fs.existsSync(path.join(dir, "app.py"))) return "backend";
  if (fs.existsSync(path.join(dir, "package.json"))) return "website";
  return null;
}

function findSiblingOf(otherType) {
  const parent = path.dirname(root);
  let hits = [];
  try {
    for (const name of fs.readdirSync(parent)) {
      const p = path.join(parent, name);
      if (p === root) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (detectType(p) === otherType) hits.push(p);
    }
  } catch { /* parent not readable */ }
  return hits.length === 1 ? hits[0] : null;
}

function writeFiles(map, label, baseDir) {
  let written = 0;
  let upToDate = 0;
  for (const [rel, packed] of Object.entries(map)) {
    const dest = path.join(baseDir, ...rel.split("/"));
    const content = unpack(packed);
    if (fs.existsSync(dest)) {
      try {
        if (fs.readFileSync(dest).equals(content)) { upToDate++; continue; }
      } catch { /* fall through and overwrite */ }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    written++;
    ok(label + " " + rel);
  }
  console.log("  (" + written + " written, " + upToDate + " already up to date)\n");
  return written;
}

function patchSidebar(dir) {
  const file = path.join(dir, "app", "admin", "components", "AdminSidebar.tsx");
  if (!fs.existsSync(file)) { warn("AdminSidebar.tsx nahi mila (skip)"); return; }
  let s = fs.readFileSync(file, "utf8");
  if (s.includes('href: "/admin/customers"')) { ok("AdminSidebar: Customers link already present (skip)"); return; }
  const anchor = '{ label: "Leads", href: "/admin/leads", icon: "\u25c7", enabled: true },';
  if (!s.includes(anchor)) { warn("AdminSidebar anchor nahi mila — Customers link manually add karein"); return; }
  s = s.replace(anchor, anchor + '\n  { label: "Customers", href: "/admin/customers", icon: "\u25c9", enabled: true },', 1);
  fs.writeFileSync(file, s);
  ok("AdminSidebar: Customers link add ho gaya");
}

function patchProxy(dir) {
  const file = path.join(dir, "proxy.ts");
  if (!fs.existsSync(file)) { warn("proxy.ts nahi mila (skip)"); return; }
  let s = fs.readFileSync(file, "utf8");
  if (s.includes('"/dashboard/forgot-password"')) { ok("proxy.ts: forgot/reset allowlist already present (skip)"); return; }
  const anchor = 'pathname === "/dashboard/unavailable"';
  if (!s.includes(anchor)) { warn("proxy.ts anchor nahi mila — forgot/reset routes manually allowlist karein"); return; }
  s = s.replace(
    anchor,
    anchor +
      ' ||\n      pathname === "/dashboard/forgot-password" ||' +
      '\n      pathname === "/dashboard/reset-password"',
    1
  );
  fs.writeFileSync(file, s);
  ok("proxy.ts: forgot/reset-password allowlist me (pre-auth access)");
}

function gitCommitPush(dir, label) {
  if (!fs.existsSync(path.join(dir, ".git"))) { warn(label + " git repo nahi hai (skip push)"); return; }
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feat: portal WhatsApp channel + AI agent config + connector API (008)"], { cwd: dir });
    execFileSync("git", ["push", "origin", branch], { cwd: dir });
    ok(label + ": commit + push ho gaya (" + branch + ")");
  } catch {
    warn(label + ": commit/push fail — khud karein: git add -A && git commit && git push");
  }
}

const writtenByDir = new Map();

function applyTo(type, dir) {
  info("Repo mila: " + BOLD + type + OFF + "  ->  " + dir);
  console.log("");
  let count = 0;
  if (type === "website") {
    count += writeFiles(WEBSITE_FILES, "[website]", dir);
    patchSidebar(dir);
    patchProxy(dir);
  } else {
    count += writeFiles(BACKEND_FILES, "[backend]", dir);
    ok("[backend] app.py: composite WSGI entry point (managed file)");
  }
  writtenByDir.set(dir, count);
}

const selfType = detectType(root);
if (!selfType) {
  fail("Yeh folder koi OmniFlow repo nahi hai.\n" +
       "   Website root: jahan package.json hai   |   Backend root: jahan app.py hai\n" +
       "   Script file ko project root mein rakho aur 'node omniflow_portal_setup.mjs' chalao.");
}

const touched = [];
applyTo(selfType, root);
touched.push({ dir: root, type: selfType });

const otherType = selfType === "website" ? "backend" : "website";
const sibling = findSiblingOf(otherType);
if (sibling) {
  console.log(CYAN + "==> " + OFF + "Doosri repo mil gayi (aik hi parent me): " + BOLD + sibling + OFF + "\n");
  applyTo(otherType, sibling);
  touched.push({ dir: sibling, type: otherType });
} else {
  console.log(CYAN + "==> " + OFF + "Doosri repo is folder ke saath nahi mili (us repo me bhi chala sakte ho).\n");
}

if (doPush) {
  console.log("");
  for (const t of touched) {
    if ((writtenByDir.get(t.dir) || 0) > 0) gitCommitPush(t.dir, "[" + t.type + "]");
    else ok("[" + t.type + "] koi change nahi — push skip");
  }
}

console.log("\n" + GREEN + "============================================================" + OFF);
console.log("  Portal module apply ho gaya!");
console.log("  - Backend deploy (~2 min): portal WhatsApp + bot config + connector API");
console.log("  - Tables lazily khud ban jati hain (008 SQL manual zaroori NAHI)");
console.log("  - Test: /dashboard/channels/whatsapp -> 'Live from Control Plane'");
console.log("  - Test: /dashboard/bot -> agent config save -> 'Saved to the server.'");
console.log(GREEN + "============================================================" + OFF);