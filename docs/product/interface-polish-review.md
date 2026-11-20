# Interface polish review

Full review, 20 November 2026. Applied the user-selected [make-interfaces-feel-better skill](https://github.com/jakubkrehel/make-interfaces-feel-better/blob/main/skills/make-interfaces-feel-better/SKILL.md) and its typography, surfaces, animations, icons and performance references. Framework: Next.js 16.4.5 / React 19; existing Tailwind primitives and plain self-serve CSS. No styling or animation dependency was added.

Scope: site-wide shared primitives, all seven self-serve destinations, the real Instagram thread, business entry, account, status, access and CSAT. Original sign-in and legacy workspace forms were inspected through source/shared styles; their complete authenticated workflows are covered separately by the repository regression suite. Retired simulator views are excluded. The supplied wireframes remain visual authority.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | Root antialiasing, global headings/placeholders, shared StatCard, workspace descriptions, badges, numeric fields and timestamps; desktop/mobile renders | Three systemic findings addressed; existing fonts retained |
| Surfaces | Shared controls across 36 source files, rule editing/removal controls, handover switches, segmented filters, card nesting and homepage | Hit targets and the requested homepage removal addressed; structural borders/radii retained |
| Animations | Action-button hover/press/release at 10% playback speed, interrupted release, reduced-motion emulation, disabled consult, error dismissal and loading/status controls | Restrained feedback and reduced-motion handling addressed |
| Icons | Lucide navigation, source/voice edit controls, handovers, error dismiss and service-status back link | Shared stroke and decorative-icon semantics addressed |
| Performance | Repository search for transition-all, transition: all and will-change; existing CSS transitions and page-load behaviour | Clear: explicit properties, no new compositing hints, libraries or staged entrances |

## Changes made

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| LOW | `src/app/globals.css:191` | Only some headings balanced; description wrapping varied | Balance shared headings and pretty-wrap short workspace descriptions | Improves short-text composition without changing transcripts or fonts |
| LOW | `src/components/stat-card.tsx:16`, `src/app/globals.css:226`, `src/components/self-serve/self-serve.css:305` | Some changing totals/dates used proportional figures | Tabular figures for shared counters, badges, timestamps and numeric inputs | Reduces digit-width shifts |
| MEDIUM | `src/app/globals.css:241`, `src/app/globals.css:444`, `src/components/self-serve/self-serve.css:1497` | Placeholder opacity reduced contrast; mobile fields could remain 13–14px | Opaque existing placeholder colour, 16px mobile fields and 44px field height | Improves legibility and mobile form interaction |
| MEDIUM | `src/app/globals.css:221`, `src/components/self-serve/self-serve.css:641`, `src/components/self-serve/self-serve.css:1055`, `src/components/self-serve/self-serve.css:1468` | 32px edit/segment controls, small dismiss targets and a 24px switch box | 40px desktop / 44px mobile targets; switch hit area extends without enlarging the track; standalone links/nav/checkbox labels follow the same minimum | Makes compact controls easier to hit; actual boxes avoid overlapping edit/delete targets |
| LOW | `src/app/globals.css:428`, `src/components/self-serve/self-serve.css:1069` | Feedback/reduced-motion coverage differed between shared controls | Explicit 140ms ease-out transitions, 0.96 action-button press scale, data-static opt-out, and no movement under reduced motion | Keeps feedback interruptible; routine navigation and rows remain restrained |
| LOW | `src/components/self-serve/workspace.tsx:230`, `src/components/self-serve/self-serve.css:83`, `src/components/service-status.tsx:18` | Text multiplication glyph for dismiss, 1.8px workspace strokes and an unhidden decorative back icon | Named Lucide dismiss control, consistent 2px strokes, decorative icons hidden | Matches the established icon family and nearby text weight |
| LOW | `src/components/self-serve/home.tsx:101` | A second unavailable consultation card occupied Home | Card and its unused styles removed; the existing disabled sidebar link remains | Implements the requested homepage simplification |

## Considered but rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Shared cards | Replace structural borders with shadows everywhere | These cards separate operational content; the approved wireframes use their current structure |
| Shared typography | Introduce another typeface | Existing self-hosted fonts already implement the supplied design |
| Workspace navigation and rows | Stagger every page/row entrance | Repeated operational interactions should not replay staged motion |
| Instagram/brand images | Add rectangular outlines to every image | These assets are transparent brand glyphs, not photographic surfaces |
| Action feedback | Add a motion library | Existing CSS supports the required interruption and reduced-motion behaviour |

## Verification

- `pnpm typecheck`, `pnpm lint` and `pnpm exec next build --webpack`: passed locally.
- `pnpm test`: 1,065 passed, 180 skipped. Most skipped tests require the separately guarded PostgreSQL fixture; optional external-channel checks also remain opt-in. The relevant isolated self-serve PostgreSQL run passed all 16 tests before this visual-only pass.
- Playwright CLI: all seven workspace destinations rendered at 1440px and 390px without horizontal overflow; visible mobile fields used at least 16px text. The real conversation retained its four messages. Business entry, account, status, access and CSAT were also checked at both widths.
- Interaction checks: visible keyboard focus, hover and press feedback, a real CSS transition slowed to 10% speed, release during transition, reduced-motion suppression, empty search results, an intentionally injected polling error and its 40px SVG dismiss control. No provider call or external message was needed for these checks.
- `impeccable detect --json src/components/self-serve`: no findings before the final visual pass; release checks remain visible in [PR #4](https://github.com/gongahkia/pronto-poc/pull/4).
- The legacy Settings regression was updated to check the feature-disabled unavailable view. Its former unconditional HTTP 404 assertion no longer described the restored route: Next.js can stream the unavailable view with HTTP 200. Removed Channels/contact routes still require HTTP 404.

Approve for the inspected Chromium desktop/mobile surfaces: no actionable polish findings remain in that verified scope. Not verified: native Safari/iOS rendering, screen-reader speech output, every legacy permission-specific workflow, or a new live Instagram native-owner-resumption test. Those limits do not imply acceptance of uninspected flows.
