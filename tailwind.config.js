/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Muted palette reminiscent of Claude Desktop's surfaces
        ink: {
          50: '#f6f6f5',
          100: '#eceae7',
          200: '#d6d2cb',
          300: '#b6afa3',
          400: '#8c8578',
          500: '#6b6557',
          600: '#4e493e',
          700: '#36322a',
          800: '#24211c',
          900: '#17150f',
        },
        accent: {
          500: '#c96442', // Claude-ish clay/orange
          600: '#a9532f',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
