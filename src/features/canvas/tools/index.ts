/*
 * Every tool the viewport hands pointer events to. The Hand and Zoom tools move the view rather
 * than the document, so the viewport handles them itself.
 */

import { refineTool } from '../select-mask.ts'
import { brushTool, eraserTool } from './brush.ts'
import { cloneStampTool, healingBrushTool } from './clone.ts'
import { cropTool } from './crop.ts'
import { eyedropperTool } from './eyedropper.ts'
import { bucketTool, gradientTool } from './fill.ts'
import { healTool } from './heal.ts'
import { moveTool } from './move.ts'
import { objectSelectTool } from './object-select.ts'
import { lassoTool, marqueeTools, polygonLassoTool, wandTool } from './select.ts'
import { shapeTool } from './shape.ts'
import type { ToolId } from './state.ts'
import { typeTool } from './type.ts'
import type { ToolHandler } from './types.ts'

export const HANDLERS: Partial<Record<ToolId, ToolHandler>> = {
  refine: refineTool,
  move: moveTool,
  marquee: marqueeTools.rect,
  'ellipse-marquee': marqueeTools.ellipse,
  lasso: lassoTool,
  'polygon-lasso': polygonLassoTool,
  wand: wandTool,
  'object-select': objectSelectTool,
  crop: cropTool,
  eyedropper: eyedropperTool,
  heal: healTool,
  healing: healingBrushTool,
  brush: brushTool,
  clone: cloneStampTool,
  eraser: eraserTool,
  bucket: bucketTool,
  gradient: gradientTool,
  type: typeTool,
  shape: shapeTool
}
