/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: {
          DEFAULT: '#090A0F',
          subtle: '#0D0F17',
          elevated: '#121520',
          interactive: '#171B29',
        },
        accent: {
          DEFAULT: '#7C5CFF',
          hover: '#8B6EFF',
          muted: '#A78BFA',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'surface': '0 1px 2px 0 rgba(0, 0, 0, 0.45), inset 0 1px 0 0 rgba(255, 255, 255, 0.04)',
        'elevated': '0 12px 32px -8px rgba(0, 0, 0, 0.6), inset 0 1px 0 0 rgba(255, 255, 255, 0.06)',
      },
    },
  },
  plugins: [],
}
