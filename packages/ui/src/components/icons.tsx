import Svg, { Circle, Path } from "react-native-svg";

/**
 * The lucide icons the reference uses, hand-ported (24×24, stroke-based,
 * strokeWidth 2, round caps/joins) — no icon-font dependency.
 */

interface IconProps {
  size?: number;
  color: string;
  strokeWidth?: number;
}

function Base({
  size = 16,
  color,
  strokeWidth = 2,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      {children}
    </Svg>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <Path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <Path d="M8 12h8" />
    </Base>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M5 12h14" />
      <Path d="m12 5 7 7-7 7" />
    </Base>
  );
}

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M7 7h10v10" />
      <Path d="M7 17 17 7" />
    </Base>
  );
}

export function ZapIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </Base>
  );
}

/**
 * A microphone, for the control that opens the voice session.
 *
 * The trigger read `Falar` / `Speak` in 12 px text beside `PT / EN`, which is
 * two words of chrome among other chrome — nothing about it said *talk to this*.
 * A microphone is the one glyph nobody has to be taught.
 */
export function MicIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <Path d="M12 19v3" />
    </Base>
  );
}

export function SparklesIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <Path d="M20 3v4" />
      <Path d="M22 5h-4" />
    </Base>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Circle cx={11} cy={11} r={8} />
      <Path d="m21 21-4.34-4.34" />
    </Base>
  );
}

export function ThumbsUpIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M7 10v12" />
      <Path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </Base>
  );
}

export function CornerDownRightIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="m15 10 5 5-5 5" />
      <Path d="M4 4v7a4 4 0 0 0 4 4h12" />
    </Base>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <Path d="m7 10 5 5 5-5" />
      <Path d="M12 15V3" />
    </Base>
  );
}

export function RotateCcwIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <Path d="M3 3v5h5" />
    </Base>
  );
}

export function TrendingUpIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="m22 7-8.5 8.5-5-5L2 17" />
      <Path d="M16 7h6v6" />
    </Base>
  );
}

export function TrendingDownIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="m22 17-8.5-8.5-5 5L2 7" />
      <Path d="M16 17h6v-6" />
    </Base>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <Circle cx={9} cy={7} r={4} />
      <Path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <Path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Base>
  );
}

export function MessageSquareIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Base>
  );
}

export function StarIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill={filled ? props.color : "none"}
      stroke={props.color}
      strokeWidth={props.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <Path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.3l6.5-.9L12 2.5z" />
    </Svg>
  );
}

export function LayoutDashboardIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M3 3h7v9H3z" />
      <Path d="M14 3h7v5h-7z" />
      <Path d="M14 12h7v9h-7z" />
      <Path d="M3 16h7v5H3z" />
    </Base>
  );
}

export function MapIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M14.1 5.55a2 2 0 0 0 1.8 0l3.65-1.83A1 1 0 0 1 21 4.62v12.76a1 1 0 0 1-.55.9l-4.55 2.27a2 2 0 0 1-1.8 0l-4.2-2.1a2 2 0 0 0-1.8 0l-3.65 1.83A1 1 0 0 1 3 19.38V6.62a1 1 0 0 1 .55-.9l4.55-2.27a2 2 0 0 1 1.8 0z" />
      <Path d="M15 5.76v15" />
      <Path d="M9 3.24v15" />
    </Base>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="m6 9 6 6 6-6" />
    </Base>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <Path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </Base>
  );
}

export function AppleIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z" />
      <Path d="M10 2c1 .5 2 2 2 5" />
    </Base>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="m6 3 14 9-14 9V3z" />
    </Base>
  );
}

export function CalendarDaysIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M8 2v4" />
      <Path d="M16 2v4" />
      <Path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <Path d="M3 10h18" />
      <Path d="M8 14h.01" />
      <Path d="M12 14h.01" />
      <Path d="M16 14h.01" />
      <Path d="M8 18h.01" />
      <Path d="M12 18h.01" />
      <Path d="M16 18h.01" />
    </Base>
  );
}

export function SlidersHorizontalIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M21 4h-7" />
      <Path d="M10 4H3" />
      <Path d="M21 12h-9" />
      <Path d="M8 12H3" />
      <Path d="M21 20h-5" />
      <Path d="M12 20H3" />
      <Path d="M14 2v4" />
      <Path d="M8 10v4" />
      <Path d="M16 18v4" />
    </Base>
  );
}

export function UserPlusIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M2 21a8 8 0 0 1 13.292-6" />
      <Circle cx={10} cy={8} r={5} />
      <Path d="M19 16v6" />
      <Path d="M22 19h-6" />
    </Base>
  );
}

export function MoreHorizontalIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Circle cx={12} cy={12} r={1} />
      <Circle cx={19} cy={12} r={1} />
      <Circle cx={5} cy={12} r={1} />
    </Base>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Circle cx={12} cy={12} r={10} />
      <Path d="M12 6v6l4 2" />
    </Base>
  );
}

export function PieChartIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
      <Path d="M22 12A10 10 0 0 0 12 2v10z" />
    </Base>
  );
}

export function HashIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M4 9h16" />
      <Path d="M4 15h16" />
      <Path d="M10 3 8 21" />
      <Path d="M16 3l-2 18" />
    </Base>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <Path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <Path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </Base>
  );
}

export function SmileIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Circle cx={12} cy={12} r={10} />
      <Path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <Path d="M9 9h.01" />
      <Path d="M15 9h.01" />
    </Base>
  );
}

export function MessageSquareReplyIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <Path d="m10 7-3 3 3 3" />
      <Path d="M17 13v-1a2 2 0 0 0-2-2H7" />
    </Base>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M18 6 6 18" />
      <Path d="m6 6 12 12" />
    </Base>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="M20 6 9 17l-5-5" />
    </Base>
  );
}

export function ArrowUpDownIcon(props: IconProps) {
  return (
    <Base {...props}>
      <Path d="m21 16-4 4-4-4" />
      <Path d="M17 20V4" />
      <Path d="m3 8 4-4 4 4" />
      <Path d="M7 4v16" />
    </Base>
  );
}
