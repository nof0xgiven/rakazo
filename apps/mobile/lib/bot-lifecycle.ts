import type { BotMemoryBank } from "@rakazo/contracts";
import { Alert } from "react-native";
import { rpc } from "./api";
import { t } from "./i18n";
import { errorText } from "./user-error";

export function confirmDeleteBot(
  bot: { id: string; name: string; memoryBank?: BotMemoryBank | null },
  onDeleted: () => void,
) {
  const remove = async (deleteMemories: boolean) => {
    try {
      await rpc("bots/remove", { botId: bot.id, deleteMemories });
      onDeleted();
    } catch (error) {
      Alert.alert(t("Could not delete bot"), errorText(error, t("Try again.")));
    }
  };
  const message = t(
    "Its conversation, files, and routines will be permanently deleted. What should happen to its local notes?",
  );

  Alert.alert(
    t("Delete {name}?", { name: bot.name }),
    bot.memoryBank ? `${message}\n\n${t("Cloud memories stay in Hindsight Cloud.")}` : message,
    [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Keep local notes"), style: "destructive", onPress: () => void remove(false) },
      {
        text: t("Delete local notes"),
        style: "destructive",
        onPress: () => void remove(true),
      },
    ],
  );
}

export async function restoreArchivedBot(botId: string): Promise<void> {
  await rpc("bots/restore", { botId });
}
