// Kept as CommonJS so tools that require() this file work regardless of
// package.json "type". Vite/PostCSS both handle CJS config files fine.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
