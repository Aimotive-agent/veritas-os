import {
  IconAdjustmentsHorizontal,
  IconArrowsShuffle2,
  IconBlur,
  IconBorderOuter,
  IconBrightnessHalf,
  IconBulb,
  IconChartLine,
  IconCircleHalf2,
  IconColorFilter,
  IconColorSwatch,
  IconContrast,
  IconContrast2,
  IconCube3dSphere,
  IconDots,
  IconDropletBolt,
  IconDropletHalf2,
  IconFilter,
  IconGrain,
  IconPalette,
  IconShadow,
  IconSparkles,
  IconSquareHalf,
  IconStairs,
  IconSunHigh,
  IconWind
} from '@tabler/icons-react'
import type { AdjustmentKind, EffectKind, HeraldAdjustmentKind } from '../../../shared/canvas/comp-format.ts'
import type { CanvasLayer } from './engine/document.ts'
import { heraldOf } from './engine/herald-adjust.ts'

type Icon = typeof IconBlur

/** An icon for each adjustment kind, shared by the Layers panel, the Properties panel and the menus. */
export const ADJUSTMENT_ICONS: Record<AdjustmentKind | HeraldAdjustmentKind, Icon> = {
  'Hue/Saturation': IconDropletHalf2,
  Levels: IconAdjustmentsHorizontal,
  Curves: IconChartLine,
  Exposure: IconSunHigh,
  'Gradient Map': IconPalette,
  Grain: IconGrain,
  Invert: IconContrast,
  'Black & White': IconContrast2,
  'Color Balance': IconColorFilter,
  'Gaussian Blur': IconBlur,
  'Motion Blur': IconWind,
  'Add Noise': IconDots,
  'Brightness/Contrast': IconBrightnessHalf,
  Vibrance: IconDropletBolt,
  'Photo Filter': IconFilter,
  'Channel Mixer': IconArrowsShuffle2,
  'Selective Color': IconColorSwatch,
  Posterize: IconStairs,
  Threshold: IconCircleHalf2,
  'Color Lookup': IconCube3dSphere
}

/** The adjustments a new layer can be, Compositor's and Veritas's own together, in groups as photo editors list them. */
export const ADJUSTMENT_MENU: { kind: AdjustmentKind | HeraldAdjustmentKind; dividerBefore?: boolean }[] = [
  { kind: 'Brightness/Contrast' },
  { kind: 'Levels' },
  { kind: 'Curves' },
  { kind: 'Exposure' },
  { kind: 'Vibrance', dividerBefore: true },
  { kind: 'Hue/Saturation' },
  { kind: 'Color Balance' },
  { kind: 'Black & White' },
  { kind: 'Photo Filter' },
  { kind: 'Channel Mixer' },
  { kind: 'Color Lookup' },
  { kind: 'Invert', dividerBefore: true },
  { kind: 'Posterize' },
  { kind: 'Threshold' },
  { kind: 'Gradient Map' },
  { kind: 'Selective Color' },
  { kind: 'Grain', dividerBefore: true },
  { kind: 'Gaussian Blur' },
  { kind: 'Motion Blur' },
  { kind: 'Add Noise' }
]

/** What an adjustment layer is, as the panels name it: its Veritas-only kind when it has one this version knows. */
export const adjustmentKindOf = (layer: CanvasLayer): AdjustmentKind | HeraldAdjustmentKind | null => heraldOf(layer)?.kind ?? layer.adjustment?.kind ?? null

export const EFFECT_ICONS: Record<EffectKind, Icon> = {
  stroke: IconBorderOuter,
  shadow: IconShadow,
  colorOverlay: IconSquareHalf,
  innerShadow: IconShadow,
  outerGlow: IconBulb,
  innerGlow: IconSparkles
}
