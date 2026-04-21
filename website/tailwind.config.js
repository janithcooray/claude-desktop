/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Orange accent palette (replaces the usual purple found on most
        // techno landing pages). 500 is the primary brand colour.
        ember: {
          50:  '#fff6ed',
          100: '#ffe8d1',
          200: '#ffcda3',
          300: '#ffa96a',
          400: '#ff823a',
          500: '#ff6a1a',
          600: '#f14d06',
          700: '#c73906',
          800: '#9d300c',
          900: '#7e2a0f',
        },
        carbon: {
          900: '#07070a',
          800: '#0d0d11',
          700: '#15151b',
          600: '#1d1d26',
        },
      },
      fontFamily: {
        sans:    ['var(--font-display)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        mono:    ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        'ember-glow': '0 0 36px rgba(255,106,26,0.45), 0 0 72px rgba(255,106,26,0.18)',
      },
    },
  },
  plugins: [],
};
