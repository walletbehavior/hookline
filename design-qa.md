# Hookline mechanism map design QA

## Visual truth

- Shared direction: `../work/product-ux-rebuild-20261021/directive.json`
- Saved product context: `../state/product-visual-direction.json`
- Production baseline: `verification/board-live-baseline.png`
- Desktop implementation: `verification/board-desktop-spatial.png`
- Mobile implementation: `verification/board-mobile-spatial-final.png`
- Side-by-side comparison: `verification/board-before-after.jpg`

## Required surfaces

- Typography: pass. The existing editorial serif and operational monospace hierarchy is preserved.
- Spacing and responsive layout: pass. The map compresses to a single-column workspace, navigation and metric rows remain intentionally scrollable, and the page no longer produces viewport-level horizontal overflow.
- Color and materials: pass. The blackened-glass surface, copper accents, muted chain colors, and restrained depth avoid the generic neon dashboard treatment.
- Copy and evidence semantics: pass. Runtime links require exact bytecode equality, project identity remains separately sourced, recent changes use normalized observations, and the map opens the existing evidence profile rather than creating a parallel claim.
- Interaction and accessibility: pass. Mouse, touch, keyboard selection, zoom, reset, pause, visibility handling, reduced-motion behavior, and accessible status text are present.
- Browser console: pass. No errors or warnings were observed in desktop or 390 px mobile checks.

## QA history

1. Mobile metric and navigation rows exposed visible scrollbars and a small viewport overflow. Fixed with clipped page overflow and visually hidden internal scrollbars.
2. Compact-map labels overlapped. Fixed by showing only the focused and selected labels at compact widths.
3. Returning to `#/board` could retain an earlier profile selection in SPA state. Fixed by clearing the selection when the route has no record identity.

Final result: passed for release.
