import {
  adminLoginInputSchema,
  adminOverviewSchema,
  adminTokenPairSchema,
  adminUsersSchema,
} from "@/api/admin";

describe("admin api schemas (§275)", () => {
  it("validates admin login input", () => {
    expect(
      adminLoginInputSchema.safeParse({ email: "owner@omniflow.pk", password: "longenough" })
        .success,
    ).toBe(true);
    expect(adminLoginInputSchema.safeParse({ email: "bad", password: "x" }).success).toBe(false);
  });

  it("parses admin token pairs (user optional on refresh)", () => {
    expect(
      adminTokenPairSchema.safeParse({ access_token: "a", refresh_token: "b" }).success,
    ).toBe(true);
    expect(
      adminTokenPairSchema.safeParse({
        access_token: "a",
        refresh_token: "b",
        user: { id: "admin-uuid", email: "owner@omniflow.pk", role: "admin" },
      }).success,
    ).toBe(true);
    expect(adminTokenPairSchema.safeParse({ access_token: "a" }).success).toBe(false);
  });

  it("parses overview and users payloads tolerantly", () => {
    expect(
      adminOverviewSchema.safeParse({ platform_users: 12, database: true, mobile_admin: true })
        .success,
    ).toBe(true);
    expect(adminOverviewSchema.safeParse({}).success).toBe(true);
    expect(
      adminUsersSchema.safeParse({ users: [{ id: 1, email: "a@b.c" }], count: 1 }).success,
    ).toBe(true);
    expect(adminUsersSchema.safeParse({ users: [{ id: 1 }], count: 1 }).success).toBe(true);
  });
});
