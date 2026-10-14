import { useCallback } from "react";
import { PressableProps } from "react-native";
import {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

/**
 * Motion language: springy scale-down on press + light haptic. All
 * animations run on the UI thread via Reanimated worklets, so lists stay
 * at full frame rate even while animating.
 */

export const springs = {
  press: { damping: 18, stiffness: 320, mass: 0.6 },
  entrance: { damping: 20, stiffness: 180 },
} as const;

export function usePressFeedback(scaleTo = 0.97) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const onPressIn: PressableProps["onPressIn"] = useCallback(() => {
    scale.value = withSpring(scaleTo, springs.press);
  }, [scale, scaleTo]);

  const onPressOut: PressableProps["onPressOut"] = useCallback(() => {
    scale.value = withSpring(1, springs.press);
  }, [scale]);

  return { animatedStyle, onPressIn, onPressOut };
}

export function tapHaptic(): void {
  try {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // haptics are best-effort
  }
}

export function successHaptic(): void {
  try {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // best-effort
  }
}

export function errorHaptic(): void {
  try {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch {
    // best-effort
  }
}
