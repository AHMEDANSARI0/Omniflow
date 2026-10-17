import React from "react";
import { Pressable, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listWorkflows, setWorkflowStatus, type Workflow } from "@/api/workflows";
import { haptics } from "@/lib/haptics";
import { formatCompact, formatRelative } from "@/lib/format";
import { Screen } from "@/ui/Screen";
import { Button } from "@/ui/Button";
import { Card, Chip, Divider, Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §278 P3 workflows: view + toggle only (the builder stays on the web
 * portal by design). The Switch flips active <-> paused through the CP,
 * which enforces tenant isolation and refuses to activate a workflow
 * without steps. Draft/archived workflows are shown read-only.
 */

function statusColors(status: Workflow["status"]) {
  const { colors } = useTheme();
  switch (status) {
    case "active":
      return { color: colors.ok, soft: colors.okSoft };
    case "paused":
      return { color: colors.warn, soft: colors.warnSoft };
    case "archived":
      return { color: colors.ink3, soft: "transparent" };
    default:
      return { color: colors.ai, soft: colors.aiSoft };
  }
}

function WorkflowCard({ item }: { item: Workflow }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const tone = statusColors(item.status);
  const toggleable = item.status === "active" || item.status === "paused";

  const toggle = useMutation({
    mutationFn: () =>
      setWorkflowStatus(item.id, item.status === "active" ? "paused" : "active"),
    onSuccess: () => {
      // §279 P4: tactile confirmation on every pause/resume flip
      void haptics.success();
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
    onError: () => {
      void haptics.error();
    },
  });

  return (
    <Card accent={tone.color}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Text weight="semibold" numberOfLines={1}>
            {item.name}
          </Text>
          {item.description ? (
            <Text variant="caption" tone="ink3" numberOfLines={2}>
              {item.description}
            </Text>
          ) : null}
        </View>
        {toggleable ? (
          <Switch
            value={item.status === "active"}
            onValueChange={() => toggle.mutate()}
            disabled={toggle.isPending}
            trackColor={{ false: colors.line2, true: colors.ok }}
            thumbColor={"#ffffff"}
          />
        ) : (
          <Chip
            label={item.status}
            color={tone.color}
            soft={tone.soft || colors.brandSoft}
          />
        )}
      </View>

      <Spacer size={spacing.sm} />
      <Divider />
      <Spacer size={spacing.sm} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
        <Chip
          label={`${item.steps} step${item.steps === 1 ? "" : "s"}`}
          color={colors.brand}
          soft={colors.brandSoft}
        />
        <Chip
          label={`${formatCompact(item.runs.total)} runs`}
          color={colors.ai}
          soft={colors.aiSoft}
        />
        {item.runs.goals > 0 ? (
          <Chip
            label={`${formatCompact(item.runs.goals)} goals`}
            color={colors.ok}
            soft={colors.okSoft}
          />
        ) : null}
        {item.runs.failed > 0 ? (
          <Chip
            label={`${formatCompact(item.runs.failed)} failed`}
            color={colors.danger}
            soft={colors.dangerSoft}
          />
        ) : null}
        <Chip
          label={item.trigger_type}
          color={colors.ink3}
          soft={colors.brandSoft}
        />
      </View>

      {item.runs.last_run_at ? (
        <>
          <Spacer size={spacing.xs} />
          <Text variant="caption" tone="ink3">
            Last run {formatRelative(item.runs.last_run_at)}
          </Text>
        </>
      ) : null}
      {toggle.isError ? (
        <>
          <Spacer size={spacing.xs} />
          <Text variant="caption" tone="danger">
            Toggle failed - a workflow needs at least one step before it can be
            activated.
          </Text>
        </>
      ) : null}
    </Card>
  );
}

export default function WorkflowsScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const workflows = useQuery({
    queryKey: ["workflows"],
    queryFn: listWorkflows,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const items = workflows.data?.workflows ?? [];
  const active = items.filter((w) => w.status === "active").length;

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.brand} />
        </Pressable>
        <Text variant="display" weight="bold" style={{ flex: 1 }}>
          Workflows
        </Text>
        <Chip
          label={`${active} active`}
          color={colors.ok}
          soft={colors.okSoft}
        />
      </View>
      <Spacer size={spacing.sm} />
      <Text variant="caption" tone="ink3">
        Flip a switch to pause or resume. Editing steps stays on the web
        portal - the app is the remote control.
      </Text>

      <Spacer size={spacing.md} />

      {workflows.isError && items.length === 0 ? (
        <View style={{ gap: spacing.sm, alignItems: "center", paddingVertical: spacing.xl }}>
          <Text weight="semibold">Could not load workflows</Text>
          <Button title="Retry now" onPress={() => workflows.refetch()} />
        </View>
      ) : null}

      {!workflows.isError && items.length === 0 && !workflows.isLoading ? (
        <View style={{ gap: spacing.sm, alignItems: "center", paddingVertical: spacing.xl }}>
          <Ionicons name="git-branch-outline" size={34} color={colors.ink3} />
          <Text weight="semibold">No workflows yet</Text>
          <Text variant="caption" tone="ink3" style={{ textAlign: "center" }}>
            Create automations on the web portal - they appear here instantly
            and can be paused or resumed from your phone.
          </Text>
        </View>
      ) : null}

      {items.map((item, index) => (
        <View key={item.id}>
          {index > 0 ? <Spacer size={spacing.md} /> : null}
          <WorkflowCard item={item} />
        </View>
      ))}
    </Screen>
  );
}
