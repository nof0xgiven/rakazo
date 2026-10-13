import { MenuView } from "@expo/ui/community/menu";
import { type ReactNode, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export type MenuPickerChoice = { key: string; label: string; disabled?: boolean };

/** Native choice menu shared by rows with different layouts. */
export function MenuPickerMenu({
  label,
  choices,
  value,
  onChange,
  children,
}: {
  label: string;
  choices: readonly MenuPickerChoice[];
  value: string;
  onChange: (key: string) => void;
  children: ReactNode;
}) {
  const colorScheme = useResolvedAppearance();
  return (
    <MenuView
      actions={choices.map((choice) => ({
        // MenuView reports an empty id as the title, so prefix keys to keep "" distinct.
        id: `choice:${choice.key}`,
        title: choice.label,
        state: choice.key === value ? "on" : "off",
        ...(choice.disabled ? { attributes: { disabled: true } } : {}),
      }))}
      colorScheme={colorScheme}
      onPressAction={(event) => {
        const id = event.nativeEvent.event;
        if (id.startsWith("choice:")) onChange(id.slice("choice:".length));
      }}
      title={label}
    >
      {children}
    </MenuView>
  );
}

/** A list row that opens a native menu of choices; the current one carries the system checkmark. */
export function MenuPicker({
  label,
  choices,
  value,
  onChange,
  divider = false,
}: {
  label: string;
  choices: readonly MenuPickerChoice[];
  value: string;
  onChange: (key: string) => void;
  divider?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const [width, setWidth] = useState<number | null>(null);
  const current = choices.find((choice) => choice.key === value)?.label ?? choices[0]?.label ?? "";
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <MenuPickerMenu choices={choices} label={label} onChange={onChange} value={value}>
        <View
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityValue={{ text: current }}
          accessible
          style={[styles.row, divider && styles.divider, width === null ? null : { width }]}
        >
          <Text style={styles.label}>{label}</Text>
          <View style={styles.valueGroup}>
            <Text numberOfLines={1} style={styles.value}>
              {current}
            </Text>
            <NativeSymbol
              android="chevron-expand"
              color={native.tertiaryLabel}
              ios="chevron.up.chevron.down"
              size={13}
            />
          </View>
        </View>
      </MenuPickerMenu>
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    row: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    divider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.separator,
    },
    label: {
      flexShrink: 1,
      color: native.label,
      fontSize: 16,
    },
    valueGroup: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 120,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 8,
    },
    value: {
      flexShrink: 1,
      color: native.secondaryLabel,
      textAlign: "right",
      fontSize: 16,
    },
  });
}
