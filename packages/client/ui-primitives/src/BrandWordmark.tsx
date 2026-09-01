import type { IconProps } from './icons/props.ts'

/** Display options for the Qifu AI Brain wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading Qifu AI mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the Qifu AI Brain wordmark.
 * @param props.size - Height in px (default 24; width follows the selected artwork).
 * @param props.className - Extra class for layout placement.
 * @param props.includeMark - Whether to include the leading Qifu AI mark.
 * @returns The wordmark svg as decorative brand art.
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 160 : 128

  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 160 24' : '32 0 128 24'}
      fill="none"
      aria-hidden="true"
    >
      <image
        href="/brand/qifuai-wordmark.svg"
        x="0"
        y="0"
        width="160"
        height="24"
        preserveAspectRatio="xMinYMid meet"
      />
    </svg>
  )
}
