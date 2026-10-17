import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  editableFromEnvelope,
  fetchProfile,
  saveProfile,
  type EditableProfile,
} from "@/api/profile";
import { formatRelative } from "@/lib/format";
import { Screen } from "@/ui/Screen";
import { Button } from "@/ui/Button";
import { TextField } from "@/ui/TextField";
import { Spacer, Text } from "@/ui/primitives";
import { spacing } from "@/ui/tokens";
import { useTheme } from "@/ui/theme";

/**
 * §278 P3 business profile settings. GET loads the CP's free-form profile
 * document; Save merges the curated fields back (website-owned keys are
 * preserved). Human sessions only - the CP rejects portal-API-key writes.
 */

const FIELDS: Array<{ key: keyof EditableProfile; label: string; placeholder: string }> = [
  { key: "business_name", label: "Business name", placeholder: "Ahmed Electronics" },
  { key: "tagline", label: "Tagline", placeholder: "What you sell, in one line" },
  { key: "phone", label: "Phone", placeholder: "+92 300 0000000" },
  { key: "address", label: "Address", placeholder: "Shop / street" },
  { key: "city", label: "City", placeholder: "Karachi" },
];

export default function ProfileScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<EditableProfile | null>(null);
  const [savedAt, setSavedAt] = useState("");

  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: fetchProfile,
  });

  useEffect(() => {
    if (profile.data && draft === null) {
      setDraft(editableFromEnvelope(profile.data));
      setSavedAt(profile.data.updated_at);
    }
  }, [profile.data, draft]);

  const save = useMutation({
    mutationFn: (edits: EditableProfile) =>
      saveProfile(profile.data ?? { profile: {}, updated_at: "" }, edits),
    onSuccess: (updatedAt) => {
      setSavedAt(updatedAt);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
  });

  const dirty =
    draft !== null &&
    profile.data !== undefined &&
    JSON.stringify(draft) !== JSON.stringify(editableFromEnvelope(profile.data));

  return (
    <Screen keyboard>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.brand} />
        </Pressable>
        <Text variant="display" weight="bold" style={{ flex: 1 }}>
          Business profile
        </Text>
      </View>
      <Spacer size={spacing.sm} />
      <Text variant="caption" tone="ink3">
        Used across your channels, receipts and the assistant's greetings.
        {savedAt ? " Last updated " + formatRelative(savedAt) + "." : ""}
      </Text>

      <Spacer size={spacing.lg} />

      {profile.isLoading && draft === null ? (
        <Text tone="ink3">Loading profile…</Text>
      ) : null}
      {profile.isError && draft === null ? (
        <View style={{ gap: spacing.sm }}>
          <Text weight="semibold">Could not load the profile</Text>
          <Button title="Retry" onPress={() => profile.refetch()} />
        </View>
      ) : null}

      {draft
        ? FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              placeholder={f.placeholder}
              value={draft[f.key]}
              onChangeText={(text) => setDraft({ ...draft, [f.key]: text })}
              autoCapitalize={f.key === "business_name" ? "words" : "sentences"}
            />
          ))
        : null}

      {draft ? (
        <>
          <Spacer size={spacing.sm} />
          <Button
            title={save.isPending ? "Saving…" : "Save changes"}
            disabled={!dirty || save.isPending}
            onPress={() => save.mutate(draft)}
          />
          {save.isError ? (
            <Spacer size={spacing.sm} />
          ) : null}
          {save.isError ? (
            <Text variant="caption" tone="danger">
              Save failed - check your connection and try again.
            </Text>
          ) : null}
          {save.isSuccess && !dirty ? (
            <Spacer size={spacing.sm} />
          ) : null}
          {save.isSuccess && !dirty ? (
            <Text variant="caption" tone="ok">
              Saved.
            </Text>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
