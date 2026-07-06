import { Platform } from "react-native";

/**
 * Brand-gradient background, cross-platform: RN Web wants CSS `backgroundImage`,
 * native (new arch) wants `experimental_backgroundImage`. A solid fallback
 * color underneath guarantees the element is never invisible if either path
 * doesn't apply.
 */
export function gradientBg(gradient: string, fallback: string): object {
  return {
    backgroundColor: fallback,
    ...(Platform.OS === "web"
      ? { backgroundImage: gradient }
      : { experimental_backgroundImage: gradient }),
  };
}
