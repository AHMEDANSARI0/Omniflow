import {
  loginInputSchema,
  sessionUserSchema,
  tokenPairSchema,
} from "@/api/auth";
import { compareVersions, mobileConfigSchema } from "@/store/app";

describe("validation schemas", () => {
  it("accepts a valid login", () => {
    const parsed = loginInputSchema.safeParse({
      email: "owner@omniflow.pk",
      password: "longenough1",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects weak logins", () => {
    expect(loginInputSchema.safeParse({ email: "x", password: "123" }).success).toBe(false);
    expect(loginInputSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
  });

  it("parses token pairs and sessions", () => {
    expect(
      tokenPairSchema.safeParse({ access_token: "a", refresh_token: "b" }).success,
    ).toBe(true);
    expect(tokenPairSchema.safeParse({ access_token: "a" }).success).toBe(false);
    expect(
      sessionUserSchema.safeParse({ id: "u1", email: "a@b.co", role: "owner" }).success,
    ).toBe(true);
  });

  it("parses remote config tolerantly", () => {
    const parsed = mobileConfigSchema.safeParse({
      min_version: "0.2.0",
      maintenance: false,
      flags: { inbox: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("compares semantic versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("junk", "1.0.0")).toBe(0);
  });
});
