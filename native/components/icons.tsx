import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "../theme";

export type IconProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
};

function useBase({ size = 24, color = colors.ink, strokeWidth = 1.5 }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    stroke: color,
    strokeWidth,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

export const FlameIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M12 3c1.5 2.5 4.5 4 4.5 8a4.5 4.5 0 0 1-9 0c0-1.6.8-2.7 1.6-3.6C10 8.5 11 6.5 12 3Z" />
    <Path d="M12 20a2.4 2.4 0 0 0 2.4-2.4c0-1.4-1.2-2.2-2.4-3.6-1.2 1.4-2.4 2.2-2.4 3.6A2.4 2.4 0 0 0 12 20Z" />
  </Svg>
);

/** The Agni mark: fire detection protected by an operational shield. */
export const AgniMark = (p: IconProps) => (
  <Svg {...useBase({ ...p, size: p.size ?? 48 })} viewBox="0 0 48 48">
    <Path d="M24 4 39 10v11.5c0 9.3-5.5 16.6-15 21.5-9.5-4.9-15-12.2-15-21.5V10L24 4Z" fill="#101827" stroke="#40C4D8" strokeWidth={2.4} />
    <Path d="M24 12c-3.4 4-6.2 7.6-6.2 12.1a6.2 6.2 0 0 0 12.4 0c0-3.1-1.8-5.6-3.9-8.2.1 3-1.2 4.6-3.2 6.1.1-3.3.7-6.2.9-10Z" fill="#FF7448" stroke="none" />
    <Path d="M24 29.2v5.4M21.3 31.9h5.4" stroke="#F6C85F" strokeWidth={2} />
    <Circle cx="24" cy="32" r="7.2" stroke="#40C4D8" strokeWidth={1.4} opacity={0.9} />
  </Svg>
);

export const SmokeIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M5 15a3 3 0 0 1 .4-6A4 4 0 0 1 13 8a3 3 0 0 1 5 2.3A3 3 0 0 1 17 16H7" />
    <Path d="M8 19c1-.8 2-.8 3 0s2 .8 3 0 2-.8 3 0" />
  </Svg>
);

export const SignalIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M4 15v3M9 11v7M14 7v11M19 3v15" />
  </Svg>
);

export const BatteryIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Rect x="3" y="8" width="15" height="8" rx="2.2" />
    <Path d="M21 11v2" />
    <Path d="M6 11v2M9 11v2M12 11v2" strokeWidth={2.4} />
  </Svg>
);

export const GpsIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M12 21c4-4 6-7.2 6-10a6 6 0 1 0-12 0c0 2.8 2 6 6 10Z" />
    <Circle cx="12" cy="11" r="2.2" />
  </Svg>
);

export const RecordIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Circle cx="12" cy="12" r="8" />
    <Circle cx="12" cy="12" r="3.4" fill={p.color ?? colors.ink} stroke="none" />
  </Svg>
);

export const FlashlightIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M8 3h8l-1 5-2 2v9a1 1 0 0 1-2 0v-9L9 8 8 3Z" />
    <Path d="M9.5 8h5" />
  </Svg>
);

export const SirenIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M7 17v-4a5 5 0 0 1 10 0v4" />
    <Path d="M5 17h14a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1Z" />
    <Path d="M12 4V2M19 7l1.4-1.4M5 7 3.6 5.6" />
  </Svg>
);

export const ArIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <Circle cx="12" cy="12" r="2.6" />
  </Svg>
);

export const AcceleratorIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M12 20V5" />
    <Path d="m7 10 5-5 5 5" />
    <Path d="M6 20h12" />
  </Svg>
);

export const SprintIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M4 17h5l2.5-8 3 6H20" />
    <Path d="M4 12h3M5 7h4" />
    <Circle cx="17.5" cy="17.5" r="1.5" fill={p.color ?? colors.ink} stroke="none" />
  </Svg>
);

export const BrakeIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Circle cx="12" cy="12" r="8" />
    <Path d="M8 8h8v8H8Z" />
  </Svg>
);

export const ChevronIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="m9 6 6 6-6 6" />
  </Svg>
);

export const MapPinIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M12 21c4-4 6-7.2 6-10a6 6 0 1 0-12 0c0 2.8 2 6 6 10Z" />
    <Circle cx="12" cy="11" r="2.2" />
  </Svg>
);

export const LayersIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="m12 3 8 4-8 4-8-4 8-4Z" />
    <Path d="m4 12 8 4 8-4M4 16.5l8 4 8-4" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M12 6v12M6 12h12" />
  </Svg>
);

export const MinusIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M6 12h12" />
  </Svg>
);

export const CrosshairIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Circle cx="12" cy="12" r="6" />
    <Path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </Svg>
);

export const ClearIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M4.5 7h15M10 7V5h4v2M6.5 7l1 12h9l1-12" />
    <Path d="M10.5 11v5M13.5 11v5" />
  </Svg>
);

export const BellIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16Z" />
    <Path d="M10 20a2 2 0 0 0 4 0" />
  </Svg>
);

export const GaugeIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M4 16a8 8 0 1 1 16 0" />
    <Path d="M12 16 15 10" />
    <Circle cx="12" cy="16" r="1.4" fill={p.color ?? colors.ink} stroke="none" />
  </Svg>
);

export const WifiIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="M4 9a13 13 0 0 1 16 0M7 12.5a8 8 0 0 1 10 0M9.5 16a4 4 0 0 1 5 0" />
    <Circle cx="12" cy="19" r="0.6" fill={p.color ?? colors.ink} stroke="none" />
  </Svg>
);

export const CameraQualityIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Rect x="3" y="6" width="18" height="13" rx="3" />
    <Circle cx="12" cy="12.5" r="3.2" />
    <Path d="M7 6V4h4v2" />
  </Svg>
);

export const InfoIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Circle cx="12" cy="12" r="8.5" />
    <Path d="M12 11v5M12 8v.5" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...useBase(p)}>
    <Path d="m7 7 10 10M17 7 7 17" />
  </Svg>
);
