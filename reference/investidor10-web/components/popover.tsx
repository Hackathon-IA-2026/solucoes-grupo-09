import { usePalette } from "@negotiatio/ui";
import { type ReactNode, useEffect, useState } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

/**
 * A trigger + floating menu.
 *
 * Web: absolutely positioned under the trigger with a `position: fixed`
 * full-screen outside-click catcher.
 *
 * Native: React Native only hit-tests touches inside a parent's bounds, so an
 * absolutely-positioned menu overflowing the trigger's wrapper would render
 * but be untappable — instead the menu opens inside a transparent `Modal`
 * (bottom sheet), which is also the expected mobile pattern.
 */
export function Popover({
  trigger,
  children,
  align = "left",
  minWidth = 220,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align?: "left" | "right";
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const toggle = () => setOpen((v) => !v);

  if (Platform.OS === "web") {
    return (
      <WebPopover
        open={open}
        close={close}
        toggle={toggle}
        trigger={trigger}
        align={align}
        minWidth={minWidth}
      >
        {children}
      </WebPopover>
    );
  }

  return (
    <>
      {trigger({ open, toggle })}
      <Modal
        visible={open}
        transparent={true}
        animationType="fade"
        onRequestClose={close}
      >
        <Pressable
          onPress={close}
          style={{
            flex: 1,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            justifyContent: "flex-end",
          }}
        >
          {/* Stop backdrop presses from closing when tapping the sheet body. */}
          <Pressable onPress={() => {}}>
            <NativeSheet>{children({ close })}</NativeSheet>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function NativeSheet({ children }: { children: ReactNode }) {
  const colors = usePalette();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        padding: 12,
        paddingBottom: 32,
      }}
    >
      <View
        style={{
          alignSelf: "center",
          width: 36,
          height: 4,
          borderRadius: 2,
          backgroundColor: colors.borderStrong,
          marginBottom: 10,
        }}
      />
      {children}
    </View>
  );
}

function WebPopover({
  open,
  close,
  toggle,
  trigger,
  children,
  align,
  minWidth,
}: {
  open: boolean;
  close: () => void;
  toggle: () => void;
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align: "left" | "right";
  minWidth: number;
}) {
  const colors = usePalette();
  return (
    <View style={{ position: "relative", zIndex: open ? 50 : 1 }}>
      {trigger({ open, toggle })}
      {open ? (
        <>
          {/* Full-screen catcher for outside clicks. */}
          <Pressable
            onPress={close}
            style={
              {
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 40,
                cursor: "default",
              } as object
            }
          />
          <Animated.View
            entering={FadeIn.duration(140)}
            exiting={FadeOut.duration(100)}
            style={[
              {
                position: "absolute",
                top: "100%",
                marginTop: 8,
                minWidth,
                zIndex: 60,
                backgroundColor: colors.surface,
                borderRadius: 16,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: colors.borderStrong,
                padding: 6,
                boxShadow: colors.shadowFloat,
              } as object,
              align === "right" ? { right: 0 } : { left: 0 },
            ]}
          >
            <PopoverBody>{children({ close })}</PopoverBody>
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

/** Tiny scale-in on the body so it feels like it grows from the trigger. */
function PopoverBody({ children }: { children: ReactNode }) {
  const scale = useSharedValue(0.97);
  // In an effect, not during render — writing a shared value in the render
  // phase re-fires the animation on every parent re-render (and warns).
  useEffect(() => {
    scale.value = withTiming(1, { duration: 140 });
  }, [scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}
