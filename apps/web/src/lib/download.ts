import { Platform, Share } from "react-native";

/**
 * Deliver an export to the user: a real file download on web, the native
 * share sheet on iOS/Android. Content is built in-memory (reviews are already
 * client-side) so there's no extra network round-trip.
 */
export async function exportText(
  content: string,
  filename: string,
  mime: "text/csv" | "application/json",
): Promise<void> {
  if (Platform.OS === "web") {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give the browser a beat to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return;
  }
  await Share.share({ message: content, title: filename });
}
