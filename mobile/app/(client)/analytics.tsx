import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { fetchCustomerAnalytics } from "@/api/customers";
import { fetchOperations } from "@/api/portal";
import { formatCompact, formatPKR } from "@/lib/format";
import { Screen } from "@/ui/Screen";
import { Button } from "@/ui/Button";
import { Card, Chip, Divider, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §278 P3 analytics: customer tiers, repeat share, languages and top
 * spenders from the CP's /insights/customer-analytics, plus the operations
 * snapshot (orders/revenue/CSAT) - read-only BI, deep reporting stays on
 * the web portal.
 */
export default function AnalyticsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [days, setDays] = useState(30);

  const analytics = useQuery({
    queryKey: ["customer-analytics", days],
    queryFn: () => fetchCustomerAnalytics(days),
    refetchInterval: 120_000,
    placeholderData: (prev) => prev,
  });

  const operations = useQuery({
    queryKey: ["operations", days],
    queryFn: () => fetchOperations(days),
    refetchInterval: 120_000,
    placeholderData: (prev) => prev,
  });

  const a = analytics.data ?? null;
  const ops = operations.data?.operations ?? null;
  const loading = analytics.isLoading && !a;

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

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.brand} />
        </Pressable>
        <Text variant="display" weight="bold" style={{ flex: 1 }}>
          Analytics
        </Text>
      </View>
      <Spacer size={spacing.sm} />

      <View style={{ flexDirection: "row", gap: spacing.xs }}>
        {[7, 30, 90].map((d) => (
          <Pressable key={d} onPress={() => setDays(d)}>
            <Chip
              label={`${d}d`}
              color={days === d ? colors.brand : colors.ink3}
              soft={days === d ? colors.brandSoft : "transparent"}
            />
          </Pressable>
        ))}
      </View>

      <Spacer size={spacing.md} />

      {analytics.isError && !a ? (
        <View style={{ gap: spacing.sm, alignItems: "center", paddingVertical: spacing.xl }}>
          <Text weight="semibold">Could not load analytics</Text>
          <Button title="Retry now" onPress={() => analytics.refetch()} />
        </View>
      ) : null}

      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {metric("Customers", loading ? "…" : formatCompact(a?.customers.length ?? 0), colors.brand)}
        {metric(
          "Repeat share",
          loading ? "…" : Math.round((a?.repeat_share ?? 0) * 100) + "%",
          colors.ai,
        )}
      </View>
      <Spacer size={spacing.sm} />
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {metric(`Revenue (${days}d)`, loading ? "…" : formatPKR(ops?.orders.revenue ?? 0), colors.ok)}
        {metric(
          "CSAT",
          loading
            ? "…"
            : ops?.csat.avg_score != null
              ? ops.csat.avg_score.toFixed(2) + " / 5"
              : "—",
          colors.warn,
        )}
      </View>

      <Spacer size={spacing.md} />

      <Card>
        <Text weight="semibold">Tiers</Text>
        <Spacer size={spacing.sm} />
        <View style={{ flexDirection: "row", gap: spacing.xs }}>
          <Chip label={`VIP ${a?.tiers.vip ?? 0}`} color={colors.danger} soft={colors.dangerSoft} />
          <Chip
            label={`Repeat ${a?.tiers.repeat ?? 0}`}
            color={colors.warn}
            soft={colors.warnSoft}
          />
          <Chip label={`New ${a?.tiers.new ?? 0}`} color={colors.brand} soft={colors.brandSoft} />
        </View>
      </Card>

      {a && a.languages.length > 0 ? (
        <>
          <Spacer size={spacing.md} />
          <Card>
            <Text weight="semibold">Languages</Text>
            <Spacer size={spacing.sm} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
              {a.languages.slice(0, 8).map((l) => (
                <Chip
                  key={l.lang || "unknown"}
                  label={`${l.lang || "unknown"} · ${l.count}`}
                  color={colors.ai}
                  soft={colors.aiSoft}
                />
              ))}
            </View>
          </Card>
        </>
      ) : null}

      {a && a.customers.length > 0 ? (
        <>
          <Spacer size={spacing.md} />
          <Card>
            <Text weight="semibold">Top customers ({days}d)</Text>
            <Spacer size={spacing.sm} />
            {a.customers.slice(0, 10).map((c, index) => (
              <View key={c.contact_id || String(index)}>
                {index > 0 ? <Divider /> : null}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: spacing.sm,
                    paddingVertical: spacing.sm,
                  }}
                >
                  <Text weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
                    {c.contact_id || "—"}
                  </Text>
                  <Chip
                    label={c.tier}
                    color={
                      c.tier === "vip"
                        ? colors.danger
                        : c.tier === "repeat"
                          ? colors.warn
                          : colors.brand
                    }
                    soft={
                      c.tier === "vip"
                        ? colors.dangerSoft
                        : c.tier === "repeat"
                          ? colors.warnSoft
                          : colors.brandSoft
                    }
                  />
                  <Text variant="caption" tone="ink3">
                    {c.orders} · {formatPKR(c.spend)}
                  </Text>
                </View>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <Spacer size={spacing.md} />
      <Text variant="caption" tone="ink3">
        Deep reporting (products, cohorts, exports) lives on the web portal -
        this screen is the fast read-only summary.
      </Text>
    </Screen>
  );
}
