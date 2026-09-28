/** @type {import('tailwindcss').Config} */
export default {
  // The surfaces that carry utility classes: the React roots and the admin
  // console's templates.
  content: ['./src/**/*.{ts,tsx,js}'],
  darkMode: 'class',
  // Preflight stays off until the surfaces own their own spacing. The hand
  // written reset in `src/style.css` is already in place, and switching the
  // element defaults over is a per-surface change with its own visual pass.
  corePlugins: { preflight: false },
  theme: {
    extend: {
      // Every colour is the CSS custom property the design system already
      // documents, so a token change stays in one place.
      colors: {
        xw: {
          bg: 'var(--xw-bg)',
          panel: 'var(--xw-panel)',
          raised: 'var(--xw-raised)',
          hover: 'var(--xw-hover)',
          line: 'var(--xw-line)',
          'line-hi': 'var(--xw-line-hi)',
          text: 'var(--xw-text)',
          muted: 'var(--xw-muted)',
          faint: 'var(--xw-faint)',
          accent: 'var(--xw-accent)',
          'accent-hi': 'var(--xw-accent-hi)',
          'accent-lo': 'var(--xw-accent-lo)',
          'accent-fill': 'var(--xw-accent-fill)',
          'accent-fill-hover': 'var(--xw-accent-fill-hover)',
          'accent-border': 'var(--xw-accent-border)',
          danger: 'var(--xw-danger)',
          success: 'var(--xw-success)',
        },
        admin: {
          bg: 'var(--admin-bg)',
          panel: 'var(--admin-panel)',
          raised: 'var(--admin-raised)',
          line: 'var(--admin-line)',
          'line-hi': 'var(--admin-line-hi)',
          text: 'var(--admin-text)',
          muted: 'var(--admin-muted)',
          faint: 'var(--admin-faint)',
          accent: 'var(--admin-accent)',
          'accent-hi': 'var(--admin-accent-hi)',
          good: 'var(--admin-good)',
          warn: 'var(--admin-warn)',
          danger: 'var(--admin-danger)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        DEFAULT: 'var(--xw-radius)',
        lg: 'var(--xw-radius-lg)',
        admin: 'var(--admin-radius)',
      },
      // The fixed scale from DESIGN.md. Never a literal z-index.
      zIndex: {
        base: '1',
        raise: '10',
        sticky: '30',
        popover: '60',
        drag: '70',
        rail: '80',
        modal: '100',
      },
      // Interaction feedback never exceeds 200ms; page entrances are their own,
      // slower tier.
      transitionDuration: {
        micro: '180ms',
        surface: '280ms',
        page: '340ms',
      },
      transitionTimingFunction: {
        xw: 'cubic-bezier(.16,1,.3,1)',
      },
      spacing: {
        rail: 'var(--xw-rail-clearance, 110px)',
      },
    },
  },
  plugins: [],
}
