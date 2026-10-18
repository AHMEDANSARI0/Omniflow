import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminQuality, fetchAdminSiteStats } from "@/api/admin";
import { formatCompact } from "@/lib/format";
import { Screen } from "@/ui/Screen";
import { Button } from "@/ui/Button";
import { Card, Chip, Divider, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §280 P5 admin analytics: website traffic (totals, daily trend, countries,
 * browsers) + AI engine quality (answers, autonomy, handoffs, escalations)
 * from the session-guarded CP mobile-admin routes. Read-only by design -
 * deep BI stays on the web portal.
 */
export default function AdminAnalytics() {
  const { colors } = useTheme();
  const router = useRouter();
  const [days, setDays] = useState(7);

  const site = useQuery({
    queryKey: ["admin-site-stats", days],
    queryFn: () => fetchAdminSiteStats(days),
    refetchInterval: 120_000,
    placeholderData: (prev) => prev,
  });

  const quality = useQuery({
    queryKey: ["admin-quality", days],
    queryFn: () => fetchAdminQuality(days),
    refetchInterval: 120_000,
    placeholderData: (prev) => prev,
  });

  const stats = site.data?.stats ?? null;
  const totals = stats?.totals ?? null;
  const overview = quality.data?.overview ?? null;
  const aiTotals = (overview?.totals ?? {}) as Record<string, unknown>;
  const controls = (overview?.controls ?? {}) as Record<string, unknown>;
  const loading = (site.isLoading && !site.data) || (quality.isLoading && !quality.data);

  const metric = (label: string, value: string, accent?: string) => (
    <Card style={{ flex: 1 }} accent={accent}>
      <Text variant="caption" tone="ink3">
        {label}
      </Text>
      <Spacer size={spacing.xs} />
      <Text variant="title" weight="bold">
        {value}
      </Text>
    </Card>
  );

  const num = (v: unknown) => formatCompact(Number(v ?? 0) || 0);

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.brand} />
        </Pressable>
        <Text variant="display" weight="bold" style={{ flex: 1 }}>
          Analytics
        </Text>
        <View style={{ flexDirection: "row", gap: spacing.xs }}>
          {[7, 30].map((d) => (
            <Pressable key={d} onPress={() => setDays(d)}>
              <Chip
                label={`${d}d`}
                color={days === d ? colors.brand : colors.ink3}
                soft={days === d ? colors.brandSoft : "transparent"}
              />
            </Pressable>
          ))}
        </View>
      </View>

      <Spacer size={spacing.md} />

      {site.isError && !stats ? (
        <View style={{ gap: spacing.sm, alignItems: "center", paddingVertical: spacing.lg }}>
          <Text weight="semibold">Could not load site stats</Text>
          <Button title="Retry now" onPress={() => site.refetch()} />
        </View>
      ) : null}

      {/* Website traffic */}
      <Text variant="caption" weight="semibold" tone="ink3">
        WEBSITE ({days}d)
      </Text>
      <Spacer size={spacing.sm} />
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {metric("Views", loading ? "…" : num(totals?.views), colors.brand)}
        {metric("Visitors", loading ? "…" : num(totals?.visitors), colors.brand)}
      </View>
      <Spacer size={spacing.sm} />
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {metric("CTA clicks", loading ? "…" : num(totals?.cta_clicks), colors.ai)}
        {metric("Form submits", loading ? "…" : num(totals?.form_submits), colors.ok)}
      </View>
      <Spacer size={spacing.sm} />
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {metric(
          "Avg time on page",
          loading ? "…" : `${Number(totals?.avg_seconds ?? 0) || 0}s`,
          colors.warn,
        )}
        {metric(
          "Countries",
          loading ? "…" : String(stats?.countries.length ?? 0),
        )}
      </View>

      {stats && stats.daily.length > 0 ? (
        <>
          <Spacer size={spacing.md} />
          <Card>
            <Text weight="semibold">Daily trend</Text>
            <Spacer size={spacing.sm} />
            {stats.daily.slice(-10).map((d, index) => (
              <View key={d.day || String(index)}>
                {index > 0 ? <Divider /> : null}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: spacing.xs + 2,
                  }}
                >
                  <Text variant="caption" tone="ink3" style={{ flex: 1 }}>
                    {d.day}
                  </Text>
                  <Text variant="caption" weight="semibold">
                    {d.views} views
                  </Text>
                  <Spacer size={spacing.sm} />
                  <Text variant="caption" tone="ink3">
                    {d.visitors} visitors
                  </Text>
                </View>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {stats && stats.countries.length > 0 ? (
        <>
          <Spacer size={spacing.md} />
          <Card>
            <Text weight="semibold">Top countries</Text>
            <Spacer size={spacing.sm} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
              {stats.countries.slice(0, 8).map((c) => (
                <Chip
                  key={c.country || "unknown"}
                  label={`${c.country || "?"} · ${c.visitors}`}
                  color={colors.brand}
                  soft={colors.brandSoft}
                />
              ))}
            </View>
          </Card>
        </>
      ) : null}

      {stats && stats.browsers.length > 0 ? (
        <>
          <Spacer size={spacing.md} />
          <Card>
            <Text weight="semibold">Browsers</Text>
            <Spacer size={spacing.sm} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
              {stats.browsers.slice(0, 6).map((b) => (
                <Chip
                  key={b.browser || "unknown"}
                  label={`${b.browser || "?"} · ${b.visitors}`}
                  color={colors.ai}
                  soft={colors.aiSoft}
                />
              ))}
            </View>
          </Card>
        </>
      ) : null}

      {/* AI engine */}
      <Spacer size={spacing.lg} />
      <Text variant="caption" weight="semibold" tone="ink3">
        AI ENGINE ({days}d)
      </Text>
      <Spacer size={spacing.sm} />
      {quality.isError && !overview ? (
        <View style={{ gap: spacing.sm, alignItems: "center", paddingVertical: spacing.lg }}>
          <Text weight="semibold">Could not load AI quality</Text>
          <Button title="Retry now" onPress={() => quality.refetch()} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {metric("Answers", loading ? "…" : num(aiTotals.answers), colors.ai)}
        {metric("Auto", loading ? "…" : num(aiTotals.auto), colors.ok)}
      </View>
      <Spacer size={spacing.sm} />
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {metric("Handoffs", loading ? "…" : num(aiTotals.handoffs), colors.warn)}
        {metric("Blocked", loading ? "…" : num(aiTotals.blocked), colors.danger)}
      </View>
      <Spacer size={spacing.sm} />
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {metric("Open escalations", loading ? "…" : num(aiTotals.open_escalations), colors.warn)}
        {metric("Pending approvals", loading ? "…" : num(aiTotals.pending_approvals))}
      </View>

      <Spacer size={spacing.md} />
      <Card accent={controls.kill_switch === true ? colors.danger : colors.ok}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Text weight="semibold" style={{ flex: 1 }}>
            Guardrails
          </Text>
          <Chip
            label={controls.kill_switch === true ? "Kill switch ON" : "Kill switch off"}
            color={controls.kill_switch === true ? colors.danger : colors.ok}
            soft={controls.kill_switch === true ? colors.dangerSoft : colors.okSoft}
          />
        </View>
        <Spacer size={spacing.xs} />
        <Text variant="caption" tone="ink3">
          Autonomy cap: {String(controls.autonomy_cap ?? "auto")} · Guard mode:{" "}
          {String(controls.guard_mode ?? "standard")}
        </Text>
        {quality.data?.degraded ? (
          <Text variant="caption" tone="danger">
            Degraded snapshot - the CP database was busy when this loaded.
          </Text>
        ) : null}
      </Card>

      <Spacer size={spacing.md} />
      <Text variant="caption" tone="ink3">
        Deep BI (products, cohorts, exports) lives on the web portal - this
        screen is the fast owner summary.
      </Text>
    </Screen>
  );
}
