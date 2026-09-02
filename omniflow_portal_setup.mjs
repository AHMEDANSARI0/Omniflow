#!/usr/bin/env node
/**
 * OMNIFLOW — PORTAL UPDATE patch v3 (single file, SELF-VERIFYING).
 * Portal WhatsApp channel + AI agent config + profile + API keys +
 * conversations + connector ingest API (backend module).
 *
 *         node omniflow_portal_setup.mjs           (files likhega)
 *         node omniflow_portal_setup.mjs --push    (commit + push bhi)
 *
 * Kis repo mein chalao:
 *   - BACKEND repo root (jahan app.py hai)  -> 13 backend files  (PEHLE YAHAN)
 *   - WEBSITE repo root (jahan package.json hai) -> 19 website files
 *
 * Dono repos aik hi parent folder mein hain to dono aik hi run mein patch ho
 * jati hain. Har file ka SHA-256 check hota hai — copy corrupt ho to script
 * khud bata degi kaunsi file kharab hai (zlib crash nahi hogi).
 *
 * v3: chunked payload (copy-safe), per-file integrity hash, delete-list.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const doPush = process.argv.includes("--push");
const root = process.cwd();

const CYAN = "\x1b[36m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", BOLD = "\x1b[1m", OFF = "\x1b[0m";

function info(msg) { console.log(CYAN + "==> " + OFF + msg); }
function ok(msg)   { console.log("  " + GREEN + "+" + OFF + " " + msg); }
function warn(msg) { console.log("  " + YELLOW + "!" + OFF + " " + msg); }
function fail(msg) { console.error(RED + "ERROR: " + OFF + msg); process.exit(1); }

function unpack(rel, entry) {
  const b64 = entry.data.replace(/\s+/g, "");
  let buf;
  try {
    buf = inflateRawSync(Buffer.from(b64, "base64"));
  } catch (e) {
    throw new Error(
      "payload corrupt: " + rel +
      " — script copy adhoori/corrupt hai. Poora code block DOBARA copy karo. (" +
      (e.code || e.message) + ")");
  }
  if (buf.length !== entry.size) {
    throw new Error("size mismatch: " + rel + " (" + buf.length + " != " + entry.size + ")");
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== entry.sha256) {
    throw new Error("hash mismatch: " + rel + " — file copy corrupt hai. Script dobara copy karo.");
  }
  return buf;
}

const WEBSITE_FILES = {
  "app/api/omniflow/portal/api-key/route.ts": {
    size: 2485,
    sha256: "c36bbf58c085136805a02309a1213572469390bda4d3a1f6b634cb4fed11f73b",
    data: [
      "7VZNb9pAEL37V0x9QLZECE3TC5REURS1aaWCAjlVVbTYY9jEzDq76xCX8t+r/QAMCVI49FCpkg/r9c7Me28+vHxWCKlhAZeCtBT5",
      "IGeEN/hYotJXUgoJS8ikmEHYah3Xn5yPj8WMeJaL+XHijI8KYx12A+69BgAT1BcF/4bVNWWiGQBIfCy5xIGQmuUXSYJKjcQDkvv2",
      "JB7QnbfvQjO9fn8LksK63YZAYqiFxC/IUpTK+FUsw69KkFvPsC/5hNPbIkgnzpHCpJRcV2E3CAJ8ttGYqiiBrKREc0Hw+WoUxRZC",
      "IkhpYBu20AM2Z1zvlSOKuwEAzyB6VzNz3oxQupS05hHZTYAFoMlZBxaQiBQ7EJbESj0Vkv/CNGzCDJViE/NhyCcEnFbx01YIS1g2",
      "vaPT9nu7siCWQQCgZeVjOy6cMrEmsZXkqI63+ypcY9yEk3bb+YeE6WQKkQW/omio2w3gpDSjBEW2v0obDUe9xdVtjfLK2V7FDtMM",
      "lTJ5xefipWQb0bxsRriDcuVq964k9sR4zsY5bkUfyQrYhHECNRVS59V2/I/tD/WULYPAJericnTd/z7swA2yVFBeDVF/UlpympxB",
      "DwjnMEQd/Qhds4VNCF0bhj/j7r7KHvSHo8h3gvFsF05sW7Kbplqdig8u3UzIMU9TpC0VfCwQ1jvMmQKJ95jolyX8YaeE//0mdAwK",
      "VuWCpdCDaAMflW7dGxRxy3ZTFMXQOwMq8zyOgSmPmdn8nXegpAcSc3L999ue69Y0slnuWZNVuEYDdFWYLvQ7rdWxXg9CV1GhOeUr",
      "rjVlKto+Gntm5zsu/HZnDcNLbm0OVXvM0juvyJbYt46xJ7crdXvvvDNY6kx9n2xGi9NMoipzvSmp2q/rlYn4ko+z30zF1fh43Xvt",
      "R/mGebvr+//E/TsT1w/L9ZjsD2wn+EuAh2Um7g2qQpDCyBR8ExagNNOl6sBJ+7QJU3dT6ezcXKIYlnE3WAZ/AA==",
    ].join(""),
  },
  "app/api/omniflow/portal/bot/route.ts": {
    size: 3143,
    sha256: "47305cd11927d78920e4bc6e243e9ce36616a3a888fcce48c9ce7dde3a4d544d",
    data: [
      "7VZRb9s2EH7Xr7gJQyEBrqykLbDJc4qs8NruoTEa921YQYsnmQ19dEkqrpfovxeUZFmOLCwZsIcBAwzB4B2/+7674+HEeqO0hTt4",
      "o8hqJeeSEX7ErwUaO9NaaSgh02oNfhSNuz8plmO1JpFJtR2n9eXnG3fbn3iiQfUAcrS/KvtGUSbykQeg8WshNM6Vtkxepikas1A3",
      "SM5m2C0eOdvdBqFz8hgumwq5QwIMy/B3o2gEhq3xSotc0KNk6ToPzw2mhRZ25088z8NvFSwzO0ohKyi1QhG8nS2CsBKcKjIW2EEZ",
      "TIFtmbCD0oNw4gGIDIIfOtdqNJcwW2hqRQTVIcAdoCtPAneQKo4J+AWxwq6UFn8h90ewRmNY7gzXIicQtI/PIx9KKEcN0Mv4rPpX",
      "kSg9l3W9a2LXWtIq+62MbkWDLuHJSb717RodUmbTFQQV9b1AJ7w6AEHGMkpRZcPt+OxZLTwS5lNH8B5sMF9Pyxga46qK3zb9hB1S",
      "1iTNpe1Jlapb9HNB7JYJyZYSj6Iv9A5YzgSBWSlt5e44/qv4Rbdg5VBLzj8tgqaDE2hyWKeparXDW9h7hU9uuUzppeAc6Yh/EwtU",
      "/dK2zIDGL5jafuu9eNB6//3HUyvYsJ1UjMMUggN9NDb64liEUfUOgiCE6QVQIWUYAjMwZ9oKJn9pn9cF3FfmVmKD+2R5S8Y/NxSO",
      "1L2nWyYFb+k9EBefFFe/6OQwmGF6mBeZyAuNPAGrC6yRWI5kP7A1Jg2wG+sq2ycpau0wnU7BN1YLyn330nsekdViHYSRRMrtCi4g",
      "bh/l62FvI0WKQTyCs/M4bC8k4F+tSfwm1RYujRFu9li/pmwVtWz3sO6sZrjRKqsnBJM+3N+fcEkVpcKgf4Kec+qSyLRA4nLXhM41",
      "ohWUJw/TtDccZ+l1z96RG8dx6EI00BmTcsnSmx703jAEvbcPQ2+VvhGUv1OFNjNyI40n7fUTxirSoUW6HteWaTvQKj2/XsuM//yD",
      "352XSfX9cRxZNDYYvB6eqE/PqVus+Ockjk9q5o+gPCP+zwnPiP8d3RnxLtmznw5kV8Wa0TtGXGVZr0AnjA8KVGw4s8gvbVINJHdY",
      "Tk4tCxpNIW07to9Wuu62MILOYtCfZDXM/1vDv781tPvC1Xzx/urDdbPGNrQIt/ARzUaRwaCqvFuoLbOFSeA8fgllOPFK7zs=",
    ].join(""),
  },
  "app/api/omniflow/portal/channels/whatsapp/route.ts": {
    size: 2465,
    sha256: "76fe839e8a718e6a6f56daf515cae07f7b09ae63c1324e2018fe867099768d1c",
    data: [
      "7VZNb9pAEL37V0x9QLbkODRNL1ASoSjqx6GgQNRDVUWDPYZNzK67uy5xKf+98u6arwQ1HHqoVImD8ezOvHnv7azZvBBSwxKuBNdS",
      "5MMcOd3Q95KUvpZSSFhBJsUc/Dg+3fvlbHIq5pxluVicJnb/SVEn8Lsec4k9gCnpLzPUql8UVzPknPKRRl2qyAOQtlQT7yeaCd4E",
      "mKShkBrzfpKQUmPxQCamq4JgL2Wz84VwC5N3FycXIy0kfSBMSRp0CjP6pCwghXMaSDZlLy/imjtRlJSS6crvep5Hj6YgqoonkJXc",
      "4Ib31+MgNCgSwZUG3HQMPcAFMn2QkiDsegAsg+DV1jabrSZSl5KvWwnMS4AlUC1vB5aQiJQ64JccSz0Tkv2k1I9gTkrhtA6M2JQD",
      "4039NPZhBavIJTpvvzZPBsTKq+WRlatte1FG7XUbh+wQbIPvPovdZorgrN225SBBncwgML00HddMmBfAuNLIExLZYX+3WpaJmKnb",
      "LQaaZAcJPI5CUqqWmR6LpwxuOHQs1jweJZ11813J8QeyHCc57VQfywpwioyDmgmp82q3/tv2m20FV55ndetfjT8OPo86cEOYCp5X",
      "I9LvlJaMTy+gB5wWMCIdfPUTwTkl2o/AT5lq/n0Lu4fcPhyMxoE7HXV682AZNzbenLVmVXi0nTMhJyxNie9Q4WqBMNlhgQok3VOi",
      "n9r6zZ6t//2DaTsosMoFptCDYAOflI7vaxRhbI5UEITQuwBe5nkYAiqHGY1+lx0o+QMXC24P4S+zrrvFkVG5Z7Y05VotM7dF1ryJ",
      "m2W9HvjWVn69ytkunqEKdpeGrrNL2AvUAJ+9D5odnTVCp4YJHivEBNM7R9aODreWDNf3vgrtP4xHSarM9Y6ZntyI27MxcnUOzEib",
      "7v+M/Nsz0k229UwbDI1t3S3uYNUz8oZUIbiioLZgBEt3H3bgrH0ewcx+bXT2vj6CEFZh11t5vwE=",
    ].join(""),
  },
  "app/api/omniflow/portal/conversations/[id]/route.ts": {
    size: 1874,
    sha256: "5f933030e63337e078a5395b8ccc4b3d6d5654d154149a19e73a85d8e7e4794f",
    data: [
      "rVVLT9tAEL77V0x9QI5kTKD04pBKFUJteqARpGe0WY+TFfZs2NkF0uD/XvkRxzFEoqiSD9au93vNzljlK20sbOBSkzU6m2aC8AYf",
      "HLK9MkYbKCA1Ogc/ik56T6bmJzonlWb66UTW549XJYA/8lQD7AEs0F5qekTDwipNoQdg8MEpg1NtrMi+SYnMM32PFHrvpFtVJ/d5",
      "SN9abfAHigQNlzQsUvzJ+v2wpnZ+zCidUXbtjzzPU2TRpEIi3GhnsUwKn2vKlTAi5ximRueK8WIDKomBrVG0gOLryCs8D58rhYLX",
      "JCF1JMsQ4PvVLLhr6GJoEg9B1uDxHtWg4pKa2ILYhQVjEE9C2YNpBoORB6BSCD51jtVoZQ2sM9RmFFSLABvAsu4xbEDqBGPwHQln",
      "l9qoP5j4IeTILBblxq1aECja8ieRDwUUYQN0Pjyt3ioRhdc6KDOCohXfOI7qKEftZ7JzZSYJjOHa5XM05XeME7KBSkI4He4sNvuK",
      "J2RxgSbYRxjAy0sf9GIMw3+OYy6SbeH20pjQo8hUsscB6lUow14o1qwbBbVvg+wy28bTa56gU8iwZ6fCrMOoQaJ7RQmMx2PwSdu7",
      "VDtK/K3fg47f8rw73nXcFQYklgpylal9w6Xl8+a9EVgclulIPAqViXmGHxNaz4W7Lk5X8cysQSyEIuClNjZb98V+GX5+S+zBy9Gt",
      "QNzULuoutuzcbm8Xdrxne7cCpLByCUHlbZtCGVe1AIrYCpKo08ND++ioTiZS/LvTvR+K9HD7I3NZeXxeve7+Xf+/N8r/W8ptIZtG",
      "283hdgL/ms4mv65vgzqURhbhE9wgrzQxBuSyLIQNsBXWcQxnw/MQlvXvJe79boIBFINy3v8F",
    ].join(""),
  },
  "app/api/omniflow/portal/conversations/route.ts": {
    size: 1315,
    sha256: "01187787aa0cf9381c9fafcf719bfe3e1cf07422fb9feb4dc480c2b20735dbd0",
    data: [
      "lVTLbtswELzzK6Y6BDKg2G6aXmz4UARBH4fGiN1zwVArmyhNKiQVRzX074WelpwadQUdKIq7szOzS7lLjfU44M5ob41aKq7pkZ4z",
      "cv7eWmNRILFmh2A8nvRfJZ8mZqdlosx+Iurg67SMDuZMNlkZoKTzd0a/kHXcS6NdxABLz5m0tDTWc/VJCHJubX6RjtglaGkVNoTR",
      "ZuWNpS/EY7IVhuMJfXPmwpy2pnztSGRW+jyYM8botcrPXa4FkkyLkgA+36/DUQUqjHYe/Fg/FuB7Lv1ZguFozgCZIHzXC6uzlbL4",
      "zOqu8rDaBA6g0okZDhAmphmCTPPMb42VvykOIuzIOb4pf6zkRkPqFj8eByhQRE2i2+n7alUVUTAGeJs32DUX0XeqY/PGw7Bf/LyK",
      "LzmdRC8W0JlSLbuz/NAdKJ+Wa28LLe/a+Z8p6VjqTRANzhxVGNSKnYkzRZAO2njwFy4Vf1KEnPx4kKI4fvSWH6cfmnXDtPirV4cT",
      "7YoIN9NprTQE92KLsKLWylEKVm1Aaue5FmSS81N4dVULM5buR8/8S7T9j+4h58oOp9f0bfMc2+cfSpzt2sa9THceDNDXNgffcKnh",
      "tsZ6lQ/xWx+a5i268ewG82G5/vrwfdUMZ1OWpj0eyaVGOwrLdoxwgPPcZ26Gm+lthG19Z8xO7pBwhGI0ZwX7Aw==",
    ].join(""),
  },
  "app/api/omniflow/portal/profile/route.ts": {
    size: 2584,
    sha256: "ed2859f90a2f53832087687c6e79d4c59dd8cf1813f72c603096e10b480e3d17",
    data: [
      "7VZLa9tAEL7rV0x1MBIojpukF7lKaEvo41CbxDmVENbSyN5E3nV2VnFUV/+9aHf9jkt8KRQKBpvdmW+++ebh5ZOpVBrm8EkKrWTR",
      "L5jAK3wskfSlUlJBDbmSE/Db7eP1T8GHx3IieF7I2XFqnY+mjbff9bhD9QBGqD+WxAUS9ZXMeYGRB6DwseQK+1JpVnxIUyQayAcU",
      "zR2xJ9xxeQ2LqUHbDC/ktZYKvyDLUJGFz/EbSRdqgj3FR1y8LoKywhwRpqXiuvK7nufhs4nGqBIp5KVINZcCPl8OgtBQSKUgDWyV",
      "JCTAZozrvSoEYdcD4DkEb9bcLFqjnS6VWOYRmEOAOWBTrxjmkMoMY/BLwUo9lor/xMyPYIJEbNRcXPORAC4W8bO2DzXUkQM667w1",
      "vwyJ2vMAtKpcbJvL1FZlmcdujYN13t0XaTuQCE46HRsKUqbTMQQmj0W2jQrmALggzUSKMt/frK2WVaHN6WYt+wXYXvEOkw+JmhLj",
      "83RXvZV+TsFGw4PKZtv4rhTsifGCDQvciD5QFbAR4wJoLJUuqs347zqn69Wr9/Vn/2YQuHaOwWloZTJ9t5qMhVV4cP/lUg15lqHY",
      "4O9igTToMGMECu8x1bt9eLrVh//+JLn5YVUhWQYJBCv6SLp937AI22YOgiCE5BxEWRRhCIwcZzc2FzGU4kHImbCj88sYdr2dEbVO",
      "LuCbJDF20GqZc11Nm3Fa8kkS8OWwKYa/MHF37QXgnyGWZutQTo0LCLatGMEVplJl70krLkbRIqnz0DnFy7xMEZ3jwQUcsuzOibxR",
      "P7euwDKFCSfiYrRdxc6LVbSUHUK8nYj9PocE5nXjmEsFgXX88YBVBE+sKPEWZA49E7yNQiuOtFiM4foGdCobH6utxffDTRoN9C0k",
      "1nDv/lZIZaGXw/PCH+76/o42Q+xZ5xbz/zb/S9t8ucd7/cHX3vdr99ZwtATO4AppKgVh0AxQBHMgzXRJMZx0ziIY2wdRvPVACkKo",
      "w65Xe78B",
    ].join(""),
  },
  "app/dashboard/(portal)/bot/BotForm.tsx": {
    size: 10345,
    sha256: "35e1fc5ae3bf7bb5cc9220478c6b51d2a7dc92ac135cdfd31e3dc72eff0b2cc7",
    data: [
      "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",
    ].join(""),
  },
  "app/dashboard/(portal)/bot/page.tsx": {
    size: 897,
    sha256: "409cfb89630828badfd206033dd0e46a0dc8bb51743f26b3fe58b79abcabc5a9",
    data: [
      "hZLRitswEEXf/RWXPCVQx5u29GGz2dAsFPrQstD+wEQe2yLyKEjjjUPIv5fEjteBhYJAaObcO9KMbL33QXFCybrx+uKlsCXOKIKv",
      "MZnPs2E5u818LbZw/pBdROQmy8Te9IEp/8MxWi8v3u8sx/+7xI5PTSd4t9t4/eFDfdNn/XmyTJKE2ytivERFfhSqrcEKk8IHw2kf",
      "uJA9mHNBjVNQPIpB0YhR6wW/jhuvr1TydIZTgt7vBDKGY/zrdyw4YwU6kNUPXjedLQeV6bq2uhOve+m4sdMRMMMjpHFumSRAYG2C",
      "YJoAwFNu32Acxfibal5N6jalRj1qatND+qV1k+cr9wG5Tb8NSeCpWoyzyq2mn1uHwoumkWu79S6HBjI7K2WqtqwUV+pQWeWRE/D9",
      "J6hk0XfzrFqMSu3v7qHpojOKdb87Uk6/Pjzcmb5yiF7IWT1+QhmY1UoJkhwVSe6LAqFxHFH4AK0YFKONSqLQihQk8cAhjgy94Oib",
      "cJmIsFHOYSoSYRfno4vvh/5luX17Tm6n/psNpBWrltzq1A34PCS2ZHYseTfUJnB+Q9ZzM8SwXqMgF/mmy7qyfVFgtkzOyT8=",
    ].join(""),
  },
  "app/dashboard/(portal)/channels/whatsapp/page.tsx": {
    size: 9113,
    sha256: "ef10d8b8b9c1c3dc16d9c1d3d483a957a6e507c9fb88eeafdcb85f7c73dbe325",
    data: [
      "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",
    ].join(""),
  },
  "app/dashboard/(portal)/conversations/[id]/page.tsx": {
    size: 6091,
    sha256: "bccb5adb5574ededf5590b6e4d0648627ecd81c1b212f70b72751697b8f2cee1",
    data: [
      "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",
      "PE9WzcIvsv9oJD6x1a7ahzLV1LHyuLnXN4+9/wM=",
    ].join(""),
  },
  "app/dashboard/(portal)/conversations/page.tsx": {
    size: 6849,
    sha256: "d53eaa596e5a73f22a5ed5fc6689a5c5488a1492cd7786d3d25c5db00fcb9547",
    data: [
      "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",
    ].join(""),
  },
  "app/dashboard/(portal)/page.tsx": {
    size: 4761,
    sha256: "88ee5b22750dcc3b124086e08584c850f117f58f77ef5a8d1207936e5a0cab29",
    data: [
      "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",
    ].join(""),
  },
  "app/dashboard/(portal)/profile/actions.ts": {
    size: 2020,
    sha256: "a42203da639ed2d1e0d6c2432a682d432771bdfd83fdb29765748e23a1e714b1",
    data: [
      "pVVta9tIEP6uXzGnD0UGnRIO7otdN+SuLRRKGtr0QyklrKWRvWS1o87s2nGD4X7E/cL7JceuXhzHDuU4MFi7zDzzzPPMSKkXBEFe",
      "I6ezJNFNS+zgAf4k65jMtVEWP+J3j+LeMBPDDmqmBtKiOBt/Ri/OqLG6NrQ5K7vMX9uQms5GyASA8bvXjNfETpnLskSRG7pDmycA",
      "otb4hxdtUeSaqdYG8+SnxdoIFZjjfSyjrUOuVYnQg1yWTpP95JTDyEF8rDuFBZFBZWcJQIMiaolTEMfaLmfJLklKsuLgw/XNuw9X",
      "l+9v37578/71J5jD1wQg1bby4nibBuZpuyKL3eMGF6Jdf1BVxSjSHZxu8McYt+g7vV2R5z6iwlp5426NskuvliHyGyiByGSWJLW3",
      "sReoNZoqq4mb18qpKbztn3Kwqhm7yKFR91OwvlkgT4bbqEHXG6sNzGGAKZbospA/mY0Ra2U8whzctkWqu4T5HNIOKoWLcFU41k02",
      "KcToErPzWHYCU0jTWbTcebYdUtS190nJ1pYwtuTbSrmn/mcJwG3LuNbkJTo4PeFq0O5Yi2QSYxst+PI451WUYU26elJglozNq/18",
      "whzURmn37ABnUTRdQ/bLo7RJrDJq8LCfvVoZwXw/d+kX8gyCpeewjSJBEy1gKfBweo1FCrtQY7cnOMzQlWqCSYdTkT+aseBqmsNv",
      "5+d7mo+T/wPPwaE4aYFhr0h1gl/byT6Fj1gSVy+Hsez+X8EcHuCA4/SwpYhXE0PW4cWSVD/dyYF9X+5rCPt2Qo9wn8PvvQiRp+Nt",
      "n9xvBIo3bnT7xCspe2RvPpSMgL2uHURRkq310jNWA729vP0Rnso83g9yjxcA6c0Kh3LQUOVNVF+cNgaYjAmrTd4BWXCr4Y0O//z1",
      "d2xSLZW2ICtiZ7ZFOpTadcR3R/Tp7n/Q7mUs+jNcXBzSL8mbKo72AqPG1TOMjufRsT8Yx96VAaUfQSiVK1eQYfhgDY2E9uIFaCtO",
      "2TK80Z79yr14ATG40PLZKu9WxPrHKTN/vtPdMuN9G9YkOsJoSFXRp1Ytx9V+vu0j6Ct0G+K7jmPEbA0qwb3Z+33cJf8C",
    ].join(""),
  },
  "app/dashboard/(portal)/profile/page.tsx": {
    size: 1410,
    sha256: "d79d3fe2f02147018ab1fbf2b42268cc7602006fe4fcac4e18db17e353133b59",
    data: [
      "fZTbattAEIbv9RQTXQQbLMnOoVAcBxKaQCCkpkkuSilhrB1JS1a7yh5sGWPoQ/QJ+yStZFmR0qYg2NPMP/9+s4jnhdIWNqCJcU2x",
      "hS0kWuXgSyptJHHJU7RcSX/q8V3sXKuEC7pWOh/BBuy6ILh0hksypjlrRcKoE/0qsfEAPl1dXzzePjxdPt7f3F3d3z/Nv3y+vrm9",
      "GnkAKdk3itWuphfHNc2Vtigu4piMeVDPJEdeWy6M2k/wRaRyyROhVlFR5/hTz/OorC3EShoLbC0x5zHMwE+UjiloNqrIJpBRgk5Y",
      "QLOWMSROxhWOtzeeY0qDYX2xnTK++oMZ4Aq5ffcCg+HUA+AJDA46acO2JwM/YmiyhULNIqFSLv3h1GtLaTKVwX2Vv+ENuqrTNq9o",
      "mjWrbQOEYfi/ptQBu1ohQ4vV3hbQvEVRO9NknZYwqPPOGF9CLNCYO8xp5udlgM4qyLEMVsFxKfzzOu4fkYvgQ3sIcJZNuqeWShsc",
      "lQISJW1gKOcLJRhYjfEzl2lgeZpZqKNWGbfUUYLW9R7Da5Eom3RKFj0/NpjsBE3ejAItBSfjcU/8q3IaLm4AU5IWUJoVaQMvjkz1",
      "eAxUtVOwGW/Lw68fP6s5c7E1I8iU02bUURQoU4cpAUpW9c9iXL1Ni1yYsOO9aFFGjC/PvWa1OWg6FyuZ8NRpYnB42PTnPfKglZOM",
      "WM14oTQj3QwB5gvS1bWjySks0s762zgcH3+HogxOoVgHJz0ufZo9kDuFo/E4+thnCfCQUYspV8wJAm5AKyEqispZUBJsRmBIL/94",
      "rFCulYMYJSRciOqsJ5gonYNUqxqmwSUBl4AQK1cIApVAzqWz1AHbQ9vC3S2G2z3ls87fbu94tmkmW4h2GW3ycOptvd8=",
    ].join(""),
  },
  "app/dashboard/(portal)/settings/ApiKeyCard.tsx": {
    size: 7207,
    sha256: "94e4b77ab46862bf694c961e11a1f816421e353f7e5f39b81d98f9a5e1296fc4",
    data: [
      "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",
    ].join(""),
  },
  "app/dashboard/(portal)/settings/actions.ts": {
    size: 2193,
    sha256: "d1eae436eabe008c8411c4c1d033a142ba616b1e27c76ac42e5f4b0f16a41bf2",
    data: [
      "7ZTPbhoxEMbv+xTTPUREouQObRDqH6mKFKE2PfQUGe8sWBjPZmyzoRFSH6JP2Cep7N31UkiaSw89REICD57v+3k849xbBIu8Rc4n",
      "WaY2FbGDB3hHxjHpuRYGP+OdR+s+MBPDHkqmDeSj0UX6aLW4oI1Rpab6QjaZr6uQmk+SZAbAeOcV45zYCT2TEq29oTWaYfxvS2uc",
      "VeoKdyDsH+sWIG4jJ1wbHmbPwlTRKpwM7yOGMg65FBKh0ZhJp8h8CaIR0fqINYYFkUZhJhnABq0VSxyDdazMMoQM1le4m/ahfXIQ",
      "dmcklN5EZViiQU7IgwzgtmLcKvI2uo5PQcI5b0vizXvhxBg+tr+y8zHMmTbK4puTnMtIvyVVHOlPUrhTnGQZgCRjHYj+DuAtiFoo",
      "9+QlDc6DlCph8Oog7Tz6hutzng089AUshbY47IuXfyPPYFF6Dh1nbaiOsmAocDi1xVEO++CxD4COd610g8povXY95UEfDA55JjEn",
      "YjYpI1p3kD1mu4Rj3BRP2K1Iu4bpFPKbFcIadyDJ6yLyLzDdczHKO5V9w7LPHnFOvo59su1ME0V+jTXM5p+iXXKAXz9+gqRqB8qB",
      "oXoYvmuldcdiV1QbEEuhTE/TtGw6UFCcTsGbAktlsGi2NfUHKZxcwQDDxHfFCyWNAVDGOmEkUvn0M3F2BnHzSNmvRni3IlbfsTi9",
      "iecbpukUvK8Ut2dn1CQKcCuESixT3xyX+i/S1+hq4nXDGDUrjcJibLu2cF0zPjnah0/Uy2D/q8E+fff/i/luuJ6b7qO5PihSN8VJ",
      "52XWHp213w==",
    ].join(""),
  },
  "app/dashboard/(portal)/settings/page.tsx": {
    size: 1230,
    sha256: "7528d3982304e706d301ff6b937f68d6bc74941048867eb2e7a0e9506295c284",
    data: [
      "dVRRa9swEH7Xr7j5KYE6brexh6ZpKX0ag1HYRh+DIp+dw7LkSefEoct/H5YVx2YMDJbuvvvuvk9CVDfWMbyDw5wcKoYzFM7WkBjs",
      "ODPyQKVksiZZCxqwzw19w9OLdHlErrJr6Ap7FwAl8pD6agp7IwAc/m7J4at1LPWzUuj9T1uhuRGXtqtVNn6adpmtDRXaHrMm1CRr",
      "IQR2oYOyxjPkJyNrUrCBpLBOYRoDPTICcyxkqxmkPxkFRWtUrwheNKHhH8hMpvSvssTFMow9EMvreLABeZTE/51/sVwLACpg8WFS",
      "thxdXSRZLv1+Z6XLM21LMslyLQSARoZq8Oc+9IZ+u20cFtTdg2dHplyHuMODrTC/h521GqUZosqhZMy3kudoLT1vWz/LwB8wrdY9",
      "4BzXsIkhAcDuFEcYDCBT2FH57CgXU5FDv157X7BS1hRUtg7zZWSDi0LYjJG5zFBY4ek17OHpCRJbVNvkZkSP4gM07q7pqQvDFEPg",
      "mQPZhGjuS8D2oV++B19g50HTORilJKv99WyikNFIEa41t87AImAecjqA0tL777LGTVJ3qWzZQi279Jh+6nTyGNv8g9ylX8YkwMP+",
      "bppl7Dj92GkorOHUY007q3NgJ1VFpkyZyj1DQB33xDhhArjc8it5tr+btGpmc3B6NxD5Ov61ZEw/397OSN+sq3wjFYJH1TriE0iT",
      "AxnG0oVXo79J7Kz2UFgHJ9s6YDTS8GoySDP6keV0eBSX3eShib5v3uPiDNlQFEsAlmtxFn8B",
    ].join(""),
  },
  "lib/omniflow/portal.ts": {
    size: 20177,
    sha256: "bdb6526851647fd2ea20ebd352f7df8fb459a3c6b420d4b5837646dca0666921",
    data: [
      "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",
      "1ro/cHTnRhdYOzBW//m4tnvN1x306lVRLP8f",
    ].join(""),
  },
  "docs/PORTAL_API.md": {
    size: 5582,
    sha256: "e594b0fb4c7ce3e9eaf30f074c523ed995a2e43dd3e6b002d39e50ddec113ebd",
    data: [
      "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",
      "2/8D",
    ].join(""),
  },
};

const BACKEND_FILES = {
  "app.py": {
    size: 2878,
    sha256: "778ca4d771b15041a232090cc6c28a82ed7c0e37041354e7859439792cd0b2da",
    data: [
      "jVbNcho5EL7rKbqGy0wZhmRrT6ni4HWwl93EsODd5CaLmR5GZSEpag3gWx5in3CfZEvzA5iAY06D+vv6R/2nKIruKi0z4zRcwT/o",
      "MlSA2rtnsEZqD4Vx4EuE6VrLW2W2cGO0d0bBTAmNcD2bwOZ9GkURY3JtjfNgqPuiZ2KFM2uwwpdKLqE9nwlfMsZm8+kf45sHPp9O",
      "H2BUn8acF1Ih50nqkIzaYJykVjjUni3mN/zjZB6Qx8QhROSyYL4A8i5uYQlo40Hq4EQa7H9gALD/l0pN6Hz8rv+ClDDWgzkWFSFY",
      "JaT2uPMwM+RXDhd/fQLvhKY6CNygBlmAAOvMRubo4O/5JzBr6QmI1NrkmDJDKeqNdEanhD7HQlTKx9HsbrH49Hn6cRz1IXL4rZIO",
      "o4Q1t1UoQU/dXd3Wf6AH2nwTH2D867tfWljWJILbkIi09N5yYWXHyxwKj/wFqJa/VFVrEpUvuRVEW+Ny7pDQd2qWFgSdA/ClPasq",
      "X0vNK0JHJyoOggvUABaKZ6XQGtUJ/UT4uoql8WfZS+NfJ1pnQvmdJbey1xUIK5/w+bzvrewn0Ru9QUfCS6MvXMEx4oKyzGiNmTfu",
      "uCIaLS9EPwmm8uWeLHXOnTGeC2uVzGrzp2XJejAYDGC886gpyFHn9RQhiLvqgaa8rpqCgKvWGFwdPEuClsFgwHoXqzhOwKGvnKZ6",
      "OLUzqR5JYSJ9WdxNYOuEtej6sC1lVrIe5Aapngq4s4awZjbtJTV5oTPsA5n6GLsQCJTcYJgjvkTpwGw16wGthVItV1gLQoe4vlVI",
      "nkA4hFySFT4rMYflc7CnZCZ9PSCsw0LukFImql24TRg1muLIrLUslNnyg/ko6WCpw5Ukj44vVYXWSe3j8335OuVFH74K/bHn3gJv",
      "muwtyENHvQV9aJ83OX3SJa9yTnsiYYyPvz6M7xeT6T2fzce3k6/jBYwgrndINBRWDjfvh+H6h4VxK+MHXRai/hlMnZnLkJCSYZ2S",
      "86KGnpkcfwA04Q5Pj/cRBUnCGMuUIAJ+Y9bWkPT4hVay2YhRFH3sqpUOhV/vbAJvoL24fth47tmXUq8AVeifpleuZ5Nm/wdtORbA",
      "udTScx4TqqIP1sm1cM/9oChpbNabGFWR8lYIow52IhfVDkaBeaw+E0rt1bfrNexx4XxoAms04ZGlEAmMOmC6wrCArx9+55P722lY",
      "wFGyx8qihqe1MtrK8CT5sRSOlIdfM4oOHseXfGJnGW3kl1mMHQ/d0Uka48tDst8lr37XzJpJezTbNkLJXHiErCJv1ujgNxQOHXjz",
      "hJrC7BL0FBIeEv35enIfxh3rgfTBdYilHlhnMiSCu/EDvCj6NSbw3/d/69VR87POawiLBEp0mLKziyU++q5dbx+muaTMhL5uhvTR",
      "M9WXzlSrEgR4YwcKN6jg8VFY+/gIG+GkWCpMWQ/+RLSNoNP/+Lh/4+JOkg/R7p/ERyZS1szqIyr7Hw==",
    ].join(""),
  },
  "admin_users.py": {
    size: 6655,
    sha256: "744b456b669dfe4e994ebd84d839f6426ba9f1254b77ee261ff17e4cb030b662",
    data: [
      "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",
      "CDO1AbqgTPxvTjz/Bg==",
    ].join(""),
  },
  "auth_password_reset.py": {
    size: 9845,
    sha256: "02fae145b9078ab080e72389fac1a8bbbf0a757a58b70444384025d6ff50bb81",
    data: [
      "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",
      "P9k43/t++v++BXK01Rn/v97w1I3NfwA=",
    ].join(""),
  },
  "connector_api.py": {
    size: 16220,
    sha256: "c9d4f07e3e9251594472602cfe1b3e067831a0e19c6c83dbe947f58743d3e131",
    data: [
      "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",
    ].join(""),
  },
  "portal_apikeys.py": {
    size: 6084,
    sha256: "7300a5c14907b1619806dd0cd7836ffd1e9e93ba9997f269d418566d18ea0ba7",
    data: [
      "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",
    ].join(""),
  },
  "portal_auth.py": {
    size: 6815,
    sha256: "e4a1fd60c49a01b90e1afb402e4cdf59be10d04c3f155ede7d6653a044883677",
    data: [
      "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",
      "tjNuv+u/3b7wnd3W+z8=",
    ].join(""),
  },
  "portal_bot.py": {
    size: 9581,
    sha256: "6c699ab00cc1e2bce1418c9111ddb4a5413b0cbe5a484953502f2395ed08f4e8",
    data: [
      "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",
    ].join(""),
  },
  "portal_channels.py": {
    size: 5162,
    sha256: "544f087ba949a2bb7456bf977f3501c459ea13f9b95e8964723e6325c2dff330",
    data: [
      "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",
      "6OBoRMQ1GYA5K+IuAvtXX24g+Rc=",
    ].join(""),
  },
  "portal_conversations.py": {
    size: 5873,
    sha256: "9e9e75dc853833d0ba2657ca3962f7b4ff934b3786584329821087da5fafbd83",
    data: [
      "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",
    ].join(""),
  },
  "portal_db.py": {
    size: 6572,
    sha256: "5288f3b24fd4b6ae9040e663f3ee812339a2f34a91db66e1ea650e1b64b997c8",
    data: [
      "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",
      "35+8K8vo/wA=",
    ].join(""),
  },
  "portal_profile.py": {
    size: 5003,
    sha256: "d1378d648ce568d57610e0ea2e2fef42537aed9b4e2bbe4af7f290495e14860a",
    data: [
      "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",
      "vDfA/gU=",
    ].join(""),
  },
  "migrations/007_password_reset_tokens.sql": {
    size: 902,
    sha256: "c97effce7ebcd5d810a85870b58e7d2c5db6955de7a251185cb3787511167cd8",
    data: [
      "lZLBbtMwHMbveYrv2EgNCiCKRMUh3dxikSYj8UTHJbJib7Fo7Sh26XbjxAOgPeGeZKpDs1KBpvlkyfbv+/76OYqQb7Sar80ODz/v",
      "gSVdFAmjeYY4fv8BLbd2ZzqBTlrp4Mx3qS1GGfmKjbrpuFNG+4fCIMsZnNnWDeL4dRTHkzCIIhRbjTw7I1AamTQatdHWrCUefv1G",
      "+SUFEcqZ7lUQnBUkYQQsmaUEdO55ZEVLVg41Kl+jOtQIAEAJHNaMLkpS0CTFRUGXSXGFz+Rq7G9treyq/uqMLmjGPD67TNP+3COr",
      "htsGjKyOTvH3iiKUn5LozbsJzDVcIzGJhLpRDrUREqN2zZXu91r+kB2sM50UoQ+Rt63qpK24A6NLUrJkecG+nTThzslN6yyA45o4",
      "J/PkMmWIx0OTa67WUvRpw7NRzVt8xNvwMLfY5wHHkadTedpe8K6RvaHtRoopjK6lR4z7EGUhJBeeXHeSux7+r2GGvtrsRmEQTgfB",
      "NDsnqxPBStxWJ5L3xnxQnv3P/x+p4fSF6L3mZ9BP/+HFdG/57hn+01cIp8Ej",
    ].join(""),
  },
  "migrations/008_portal_connector.sql": {
    size: 3299,
    sha256: "84bc8d764ef4568d65c47819c4381aa2e41bf6ea224b7cf612534e410e8d9912",
    data: [
      "vVbNbts4EL77KebmGOsELrCHrntSEmWhriOntoJN90JQ4thiTZEqSSXRLgr0IfqEfZIFZcl/sg0bRXuzNT+c+b5vhry8hHEm+Z1Q",
      "L3CjpNVKwIOgEuH712+Q8bmmlisJg8HbIeRKWyrgN0iUlJhYpcHSWKDpXF5CwDDLlUVp4SK4g3Acgf8UTKNpr0qVpDQtEayCEJWE",
      "6YcRIOMuRYbAVEw1hTjlzk9Q+ERLvHJZw3HkDyGmyQIlg0yxQiBcLAshLL7Kyx64tFUZIOi/XJSwSAtWJYuppMDQUkgp77t8JcKM",
      "CwR8zQVPuAWaux/LJhcIgpfonK86nZuJ70U+RN71yIetjmogyEtKraF5ToyltjBw0QFIBEdpCWdwHfwZhBE8TIJ7b/IR/vI/9jsA",
      "zhUh8p+iKmH4OBrBrX/nPY4i6DJuamiRdZ13niq59Hb/aJKoQloiabb+KKixxCBKQi1Ewb0/jbz7h+gfZ9PoKkVG4rIux30tckbd",
      "x23/djnh+O+LXqf37hQoYmVJouSMz0+Dgc5xs5E9WKxk6RnDjaXSVojYBpA9ITPNUTJRVo5zjWi5nB9yrpxmVAgnrqNOL0ovuJyT",
      "VBXaEJROawyux+OR74XtoDtvNPXbccZSbQ+dM/hjOBjsPYwdCnnztglJi4xKklLJ1Gx2Rn2NDn66OFbrgiQqy6hkS40sxTH1J4E3",
      "2tVHSz9NAZUxpVKiOIRMM5bd5cxUo73lWk0WLYWiDN5Px+H1niT/fekOh5+MknEztYU5dGCOknE57y5H7nOBpgWrRlMIS6Sy68lN",
      "NJ4O9Q9xE4S3/tMON5y9koafjBlSN9EBGIfHiFsx069R6QNnp+kg18ot39M2RO18IkG/TMs052SB5Q8q2KoFupE1aVuZCyxJrnHG",
      "X/fb3ML/vW3S+KwWrWY3dbaFzdniq+6ZwrRCztBZg13V+JbQ1qiukem9OzftEvIDiVd8nLyznlGb6mHwC9dVoqSlSZWpxXBj27r+",
      "j28mlaPsrtjL0Bg6R6euZ44v20+IxnhYPz9nT7mAm3E4jSaeA674TPYwAI9h8OHR39o+Naz9DczOWnqbBBPBjd1dfZv8b5y7i9at",
      "P705TVN10Aly2jj8kKiOKY5xjQfuvVix8uhrx6BkqM8RmcYE+XP9Yj1LLGfQ1WBXEbPF1BrVHdjqi+l/",
    ].join(""),
  },
};


const WEBSITE_DELETE = [
  "app/dashboard/(portal)/bot/actions.ts"
];

function detectType(dir) {
  if (fs.existsSync(path.join(dir, "app.py"))) return "backend";
  if (fs.existsSync(path.join(dir, "package.json"))) return "website";
  return null;
}

function hasMarker(type, dir) {
  try {
    if (type === "backend") {
      const appPy = path.join(dir, "app.py");
      if (!fs.existsSync(appPy)) return false;
      return fs.readFileSync(appPy, "utf8").slice(0, 8192).includes("control_plane");
    }
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(pkg)) return false;
    return fs.readFileSync(pkg, "utf8").slice(0, 4096).toLowerCase().includes("omniflow");
  } catch {
    return false;
  }
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
      if (detectType(p) === otherType && hasMarker(otherType, p)) hits.push(p);
    }
  } catch { /* parent not readable */ }
  return hits.length === 1 ? hits[0] : null;
}

function writeFiles(map, label, baseDir) {
  let written = 0;
  let upToDate = 0;
  for (const [rel, packed] of Object.entries(map)) {
    const dest = path.join(baseDir, ...rel.split("/"));
    const content = unpack(rel, packed);
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

function deleteFiles(list, label, baseDir) {
  for (const rel of list) {
    const dest = path.join(baseDir, ...rel.split("/"));
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
        ok(label + " removed " + rel);
      } catch {
        warn(label + " remove fail: " + rel);
      }
    }
  }
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
    deleteFiles(WEBSITE_DELETE, "[website]", dir);
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
  console.log(CYAN + "==> " + OFF + "Doosri repo is folder ke saath nahi mili (us repo me bhi chalao).\n");
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
console.log("  - Backend deploy (~2 min): portal + profile + API keys +");
console.log("    conversations + connector ingest (X-Omniflow-Key)");
console.log("  - Tables lazily khud ban jati hain (008 SQL manual zaroori NAHI)");
console.log("  - Test: /dashboard/settings -> Generate key -> ofk_... (aik dafa)");
console.log("  - Test: /dashboard/profile save -> 'Profile saved.'");
console.log("  - Test: /dashboard/conversations -> list khali (connector baad me)");
console.log("  - Test: /dashboard/channels/whatsapp -> 'Live from Control Plane'");
console.log(GREEN + "============================================================" + OFF);
