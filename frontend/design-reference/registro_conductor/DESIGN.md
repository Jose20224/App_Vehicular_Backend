---
name: Registro Conductor
colors:
  surface: '#f9f9ff'
  surface-dim: '#d3daef'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f1f3ff'
  surface-container: '#e9edff'
  surface-container-high: '#e1e8fd'
  surface-container-highest: '#dce2f7'
  on-surface: '#141b2b'
  on-surface-variant: '#434655'
  inverse-surface: '#293040'
  inverse-on-surface: '#edf0ff'
  outline: '#747686'
  outline-variant: '#c4c5d7'
  surface-tint: '#2151da'
  primary: '#0037b0'
  on-primary: '#ffffff'
  primary-container: '#1d4ed8'
  on-primary-container: '#cad3ff'
  inverse-primary: '#b7c4ff'
  secondary: '#b51a1e'
  on-secondary: '#ffffff'
  secondary-container: '#d93633'
  on-secondary-container: '#fffbff'
  tertiary: '#005011'
  on-tertiary: '#ffffff'
  tertiary-container: '#186a21'
  on-tertiary-container: '#95e88f'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dce1ff'
  primary-fixed-dim: '#b7c4ff'
  on-primary-fixed: '#001551'
  on-primary-fixed-variant: '#0039b5'
  secondary-fixed: '#ffdad6'
  secondary-fixed-dim: '#ffb4ac'
  on-secondary-fixed: '#410003'
  on-secondary-fixed-variant: '#93000e'
  tertiary-fixed: '#a3f69c'
  tertiary-fixed-dim: '#88d982'
  on-tertiary-fixed: '#002204'
  on-tertiary-fixed-variant: '#005312'
  background: '#f9f9ff'
  on-background: '#141b2b'
  surface-variant: '#dce2f7'
typography:
  display:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.01em
  title:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-medium:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
  caption:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  caption-bold:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-tablet: 1.5rem
  margin: 1rem
  margin-tablet: 1.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

This design system is engineered specifically for drivers navigating the urban and regional road conditions of Nicaragua. It balances utilitarian clarity, swift comprehension under high-glare tropical sunlight, and immediate roadside utility. 

The aesthetic is anchored in a high-clarity modern utility framework—combining principles of functional corporate UI and human-centered design for mobility. The interface prioritizes:
- **Instant Recognition:** Information is presented in clear visual hierarchies with large touch surfaces, minimizing cognitive load while operating or inspecting a vehicle.
- **Civic Trust & Utility:** A disciplined, dependable visual presence that communicates compliance, vehicle status, and safety without decorative excess.
- **Extreme Contrast & Legibility:** Designed for variable low-tier Android displays under direct sunlight, avoiding subtle tints or faint grays that impede fast scanning.

## Colors

The color palette operates under strict semantic mandates to prevent confusion, especially in critical situations:

- **Primary (`#1D4ED8`):** Authoritative driver blue used for primary navigation, actionable links, default interactive buttons, active tab indicators, and progress states.
- **Emergency Red (`#C62828`):** Reserved exclusively for high-priority emergency functions, immediate breakdown alerts, SOS toggles, and critical system halts. Never used for non-emergency dismissals or standard errors.
- **Success Green (`#2E7D32`):** Used for current, valid, and legally verified statuses (e.g., active circulation permit, valid license, completed inspections).
- **Warning Amber (`#F59E0B` on `#FFF4D6`):** Applied to documents and vehicle checks nearing expiration within 30 days. Amber icons and labels sit against a soft tinted container for clear visual separation.
- **Expired State (`#B71C1C` on `#FDECEA`):** Soft, desaturated red container with high-contrast dark red typography strictly for delinquent, lapsed, or expired legal documentation.
- **Sponsored Token (`#3730A3` on `#EEF0FF`):** Dedicated indigo tint for commercial or third-party vehicle partner placements ("Patrocinado"), preventing visual collisions with state or official alerts.
- **Neutral Canvas & Surfaces:**
  - Base Background: `#F7F8FA`
  - Elevated Surface: `#FFFFFF`
  - Primary Text: `#111827` (exceeds WCAG AAA for body text)
  - Secondary Text: `#4B5563` (minimum 4.5:1 contrast against `#FFFFFF`)
  - Structural Borders: `#E5E7EB`

## Typography

The type scale is strictly bounded to protect driver legibility on vibrating phone mounts and budget-grade device screens.

- **Hard Floor Constraint:** No text element may ever drop below `14px` (`0.875rem`). Micro-labels, sub-captions, and metadata tags stay locked at `14px` with a minimum weight of 500.
- **Inter System Font:** Utilized for its tall x-height, clear optical counters, and unambiguous tabular numerals, vital for plate numbers (placas), insurance expiration dates, and vehicle VIN references.
- **High-Contrast Enforcement:** Primary text (`#111827`) is default. Secondary text (`#4B5563`) is restricted to secondary identifiers and helper prompts, never for critical vehicle legal statuses.

## Layout & Spacing

The layout model is mobile-first, targeting single-handed vertical ergonomics with rapid touch execution:

- **Touch Surface Floor (56dp / 3.5rem):** Every interactable target—buttons, list items, toggles, form fields, and navigation icons—must fulfill a minimum bounding box of `56px` by `56px`.
- **Screen Margins & Gutters:** Mobile canvases utilize `16px` (`1rem`) outer margins. Content groups stack vertically using standard intervals of `16px` (`space-md`) and `24px` (`space-lg`).
- **One-Thumb Reach:** Key roadside confirmation triggers and critical state changes are grouped in the lower two-thirds of the viewport to accommodate one-handed operation.

## Elevation & Depth

To maximize performance on lower-resource Android chipsets and maintain sharpness under direct sunlight, elevation relies on structural borders and flat surface containment rather than multi-layered blurred shadows.

- **Flat Baseline:** Cards and surfaces use crisp structural outlines (`border: 1px solid #E5E7EB`) overlaid onto the `#F7F8FA` background.
- **Level 1 (Cards & Inputs):** Solid `#FFFFFF` fill with `1px` border in `#E5E7EB`. No drop shadow.
- **Level 2 (Floating Action / Sticky Elements):** Solid `#FFFFFF` fill with a subtle vertical boundary (`box-shadow: 0 4px 12px rgba(17, 24, 39, 0.08)` and `1px` top border in `#E5E7EB`).
- **Emergency Priority:** The central emergency action button uses pure color saturation (`#C62828`) to command attention over physical elevation tricks.

## Shapes

The interface balances soft ergonomics with structural integrity:

- **Cards & Surfaces:** Fixed corner radius of `16px` (`rounded-lg`), producing friendly and well-delineated modules that frame document cards, status indicators, and vehicle records.
- **Buttons & Interactive Controls:** Fixed corner radius of `12px` to distinguish clickable controls from outer container cards.
- **Pills & Status Badges:** Fully rounded `9999px` geometry for status tags, disclaimer markers, and sponsored chips.
- **Touch Outlines:** Interactive states preserve exact border radii without clipping inner content.

## Components

### Buttons
- **Primary Action:** Solid `#1D4ED8` background, `#FFFFFF` text, `12px` border radius, minimum `56px` height. Bold `16px` Inter typography.
- **Emergency Action:** Solid `#C62828` background, `#FFFFFF` text, `12px` border radius, minimum `56px` height. Features the rounded shield or phone icon paired with clear uppercase/sentence text (e.g., "Llamar Asistencia Vial").
- **Secondary / Outlined:** `#FFFFFF` background, `1.5px` border in `#1D4ED8`, text `#1D4ED8`. Minimum `56px` height.

### Status Indicators & Badges
- **Universal Dual-Coding Requirement:** Color alone must never represent status. Every indicator must display both an unambiguous Material Rounded icon and a text label.
  - *Vigente (Valid):* `#2E7D32` text and check-circle icon on `#E8F5E9` pill.
  - *Por Vencer (Pending/Warning):* `#F59E0B` warning icon and text on `#FFF4D6` pill.
  - *Vencido (Expired):* `#B71C1C` alert icon and text on `#FDECEA` pill.
- **Sponsored Badge ("Patrocinado"):** `#EEF0FF` background pill, `#3730A3` text, `14px` caption-bold text, marked with a small star or info icon to differentiate from official municipal alerts.

### Cards
- **Vehicle Document Card:** `#FFFFFF` surface, `16px` corner radius, `1px solid #E5E7EB`. Contains vehicle model/placa header, large title, dual-coded status chip, and explicit expiration dates.
- **Estimate Disclaimer Box:** `#F7F8FA` container with an open outline, carrying a `14px` caption explaining fee estimates (e.g., "Monto estimado sujeto a aranceles de la alcaldía").

### Form Fields & Inputs
- **Base Input:** `#FFFFFF` background, minimum height `56px`, `12px` border radius, `1px solid #E5E7EB`. Text in `16px` Inter `#111827`.
- **Focus State:** `2px solid #1D4ED8` outline with no blur glow.
- **Floating Labels / Prefixes:** Fixed at `14px` caption size to preserve legibility.

### Bottom Navigation Bar
- High-contrast persistent bar docked to the screen bottom (`height: 64px` plus safe area inset).
- **Surface:** `#FFFFFF` surface, `1px solid #E5E7EB` top border.
- **Center Emergency Element ("Emergencia"):** Visually elevated circular or prominent button housing the solid `#C62828` Emergency Red token, protruding slightly above the bar boundary with minimum `56x56dp` physical hit area for immediate thumb triggering during roadside crises.
- **Standard Tabs:** Two tabs flanking each side (e.g., Inicio, Trámites, Vehículos, Perfil) with `14px` label text and 24dp Material rounded icons.