/**
 * Slide-to-confirm — the second half of "approving must feel deliberate, not
 * accidental" (docs/06 §6.1). Biometric proves *who*; this proves *intent*.
 *
 * The gesture maths is a pure function (`slideProgress`) so it can be tested
 * without simulating touches, and the component exposes an `adjustable`
 * accessibility action so VoiceOver users have a real equivalent of the slide
 * rather than being locked out of approving.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { colors, font, radius, space } from '../theme';

/** Fraction of the track that counts as "committed". */
export const CONFIRM_THRESHOLD = 0.9;
const HANDLE_WIDTH = 72;

/** 0..1 along the track. Total: a zero-width track is never "complete". */
export function slideProgress(dx: number, trackWidth: number): number {
  const travel = trackWidth - HANDLE_WIDTH;
  if (!Number.isFinite(dx) || !Number.isFinite(travel) || travel <= 0) return 0;
  return Math.min(1, Math.max(0, dx / travel));
}

export function isConfirmed(progress: number): boolean {
  return progress >= CONFIRM_THRESHOLD;
}

export interface ConfirmSliderProps {
  label: string;
  confirmingLabel?: string | undefined;
  disabled: boolean;
  busy?: boolean | undefined;
  onConfirm: () => void;
  testID?: string | undefined;
}

export function ConfirmSlider(props: ConfirmSliderProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [progress, setProgress] = useState(0);
  const translate = useRef(new Animated.Value(0)).current;
  const locked = props.disabled || props.busy === true;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const widthRef = useRef(0);
  widthRef.current = trackWidth;

  const confirm = useCallback(() => {
    if (lockedRef.current) return;
    props.onConfirm();
  }, [props]);

  const reset = useCallback(() => {
    setProgress(0);
    Animated.spring(translate, { toValue: 0, useNativeDriver: false, bounciness: 0 }).start();
  }, [translate]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !lockedRef.current,
        onMoveShouldSetPanResponder: () => !lockedRef.current,
        onPanResponderMove: (_event, gesture) => {
          if (lockedRef.current) return;
          const next = slideProgress(gesture.dx, widthRef.current);
          setProgress(next);
          translate.setValue(next * Math.max(0, widthRef.current - HANDLE_WIDTH));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (lockedRef.current) return reset();
          if (isConfirmed(slideProgress(gesture.dx, widthRef.current))) {
            confirm();
          }
          reset();
        },
        onPanResponderTerminate: reset,
      }),
    [confirm, reset, translate],
  );

  const onLayout = (event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width);

  return (
    <View
      testID={props.testID}
      onLayout={onLayout}
      accessibilityRole="adjustable"
      accessibilityState={{ disabled: locked }}
      accessibilityLabel={props.label}
      accessibilityHint="Slide right to confirm, or use the activate action."
      accessibilityActions={[{ name: 'activate', label: 'Confirm' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate') confirm();
      }}
      style={[styles.track, locked ? styles.trackDisabled : styles.trackEnabled]}
    >
      <Text style={[styles.label, locked ? styles.labelDisabled : styles.labelEnabled]}>
        {props.busy === true ? (props.confirmingLabel ?? 'Working…') : props.label}
      </Text>
      <Animated.View
        testID={props.testID === undefined ? undefined : `${props.testID}-handle`}
        style={[
          styles.handle,
          locked ? styles.handleDisabled : styles.handleEnabled,
          { transform: [{ translateX: translate }] },
        ]}
        {...responder.panHandlers}
      >
        <Text style={styles.handleText}>{progress > 0.05 ? '▸▸' : '▸'}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 64,
    borderRadius: radius.lg,
    borderWidth: 2,
    justifyContent: 'center',
    overflow: 'hidden',
    marginVertical: space.md,
  },
  trackEnabled: { borderColor: colors.ok, backgroundColor: colors.surfaceAlt },
  trackDisabled: { borderColor: colors.disabled, backgroundColor: colors.surface },
  label: { textAlign: 'center', fontSize: font.body, fontWeight: '700' },
  labelEnabled: { color: colors.ok },
  labelDisabled: { color: colors.disabled },
  handle: {
    position: 'absolute',
    left: 0,
    width: HANDLE_WIDTH,
    height: '100%',
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleEnabled: { backgroundColor: colors.ok },
  handleDisabled: { backgroundColor: colors.disabled },
  handleText: { color: colors.bg, fontSize: font.h2, fontWeight: '900' },
});
